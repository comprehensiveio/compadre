import crypto from "node:crypto";
import { Hono } from "hono";
import type { JWTPayload } from "jose";
import { getConfiguredAuthStore } from "../services/auth-runtime.js";
import type { AuthStore } from "../services/auth-store.js";
import {
  exchangeSlackOpenIdCode,
  slackAuthorizeUrl,
  slackSubjectFromClaims,
  verifySlackOpenIdToken,
  type SlackOpenIdConfig,
} from "../services/slack-openid.js";
import {
  slackIdentityFromOpenIdClaims,
  type UserDirectory,
} from "../services/user-directory.js";
import { getConfiguredUserDirectory } from "../services/user-directory-runtime.js";

export interface SlackAuthDependencies {
  getAuthStore: () => Promise<
    Pick<
      AuthStore,
      "beginSlackLogin" | "consumeSlackLogin" | "issueLoginGrant" | "consumeLoginGrant"
    > | null
  >;
  getUserDirectory: () => Promise<
    Pick<UserDirectory, "upsertSlackIdentity" | "findActiveById"> | null
  >;
  fetch: typeof globalThis.fetch;
  verifyIdToken: typeof verifySlackOpenIdToken;
  environment: NodeJS.ProcessEnv;
}

const defaultDependencies: SlackAuthDependencies = {
  getAuthStore: getConfiguredAuthStore,
  getUserDirectory: getConfiguredUserDirectory,
  fetch: globalThis.fetch,
  verifyIdToken: verifySlackOpenIdToken,
  environment: process.env,
};

function authConfiguration(
  environment: NodeJS.ProcessEnv,
  requestUrl: string,
): {
  slack: SlackOpenIdConfig;
  t3BaseUrl: string;
  allowedWorkspaceId: string;
  serviceToken: string;
} | null {
  const clientId = environment.SLACK_CLIENT_ID?.trim();
  const clientSecret = environment.SLACK_CLIENT_SECRET?.trim();
  const t3BaseUrl = environment.COMPADRE_T3_CENTRAL_URL?.trim();
  const allowedWorkspaceId = environment.COMPADRE_SLACK_WORKSPACE_ID?.trim();
  const serviceToken = environment.COMPADRE_AUTH_EXCHANGE_SECRET?.trim();
  if (!clientId || !clientSecret || !t3BaseUrl || !allowedWorkspaceId || !serviceToken) {
    return null;
  }
  const redirectUri =
    environment.SLACK_OIDC_REDIRECT_URI?.trim() ||
    `${new URL(requestUrl).origin}/auth/slack/callback`;
  return {
    slack: { clientId, clientSecret, redirectUri },
    t3BaseUrl: new URL(t3BaseUrl).origin,
    allowedWorkspaceId,
    serviceToken,
  };
}

function bearerMatches(header: string | undefined, expected: string): boolean {
  const actual = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const actualHash = crypto.createHash("sha256").update(actual).digest();
  const expectedHash = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

export function createSlackAuthRoutes(
  dependencies: Partial<SlackAuthDependencies> = {},
): Hono {
  const deps = { ...defaultDependencies, ...dependencies };
  const routes = new Hono();

  routes.get("/auth/slack/start", async (c) => {
    const config = authConfiguration(deps.environment, c.req.url);
    const authStore = await deps.getAuthStore();
    if (!config || !authStore) {
      return c.json({ ok: false, error: "Slack login is not configured" }, 503);
    }
    const flow = await authStore.beginSlackLogin(c.req.query("return_to"));
    return c.redirect(
      slackAuthorizeUrl({
        config: config.slack,
        state: flow.state,
        nonce: flow.nonce,
        workspaceId: config.allowedWorkspaceId,
      }),
    );
  });

  routes.get("/auth/slack/callback", async (c) => {
    const config = authConfiguration(deps.environment, c.req.url);
    const authStore = await deps.getAuthStore();
    const directory = await deps.getUserDirectory();
    if (!config || !authStore || !directory) {
      return c.json({ ok: false, error: "Slack login is not configured" }, 503);
    }
    const state = c.req.query("state");
    const code = c.req.query("code");
    if (!state || !code || c.req.query("error")) {
      return c.json({ ok: false, error: "Slack login was not completed" }, 400);
    }
    const flow = await authStore.consumeSlackLogin(state);
    if (!flow) {
      return c.json({ ok: false, error: "Slack login state expired or was already used" }, 400);
    }

    try {
      const idToken = await exchangeSlackOpenIdCode({
        config: config.slack,
        code,
        fetch: deps.fetch,
      });
      const claims = await deps.verifyIdToken({
        idToken,
        clientId: config.slack.clientId,
        nonce: flow.nonce,
      });
      const subject = slackSubjectFromClaims(claims);
      if (subject.workspaceId !== config.allowedWorkspaceId) {
        return c.json({ ok: false, error: "This Slack workspace is not allowed" }, 403);
      }
      const profile = slackIdentityFromOpenIdClaims(claims as JWTPayload);
      const user = await directory.upsertSlackIdentity({
        ...profile,
        workspaceId: subject.workspaceId,
        slackUserId: subject.slackUserId,
      });
      const grant = await authStore.issueLoginGrant(user.id, flow.returnTo);
      const callback = new URL("/auth/compadre/callback", config.t3BaseUrl);
      callback.searchParams.set("code", grant);
      return c.redirect(callback.toString());
    } catch (error) {
      console.warn("[slack-auth] Slack OpenID callback failed", {
        kind: error instanceof Error ? error.constructor.name : "unknown",
      });
      return c.json({ ok: false, error: "Slack login could not be verified" }, 401);
    }
  });

  routes.post("/internal/auth/exchange", async (c) => {
    const config = authConfiguration(deps.environment, c.req.url);
    if (!config || !bearerMatches(c.req.header("authorization"), config.serviceToken)) {
      return c.json({ ok: false, error: "Unauthorized" }, 401);
    }
    const authStore = await deps.getAuthStore();
    const directory = await deps.getUserDirectory();
    if (!authStore || !directory) {
      return c.json({ ok: false, error: "Authentication persistence unavailable" }, 503);
    }
    const body: { code?: unknown } = await c.req
      .json<{ code?: unknown }>()
      .catch(() => ({}));
    if (typeof body.code !== "string" || body.code.length < 20) {
      return c.json({ ok: false, error: "Invalid login grant" }, 400);
    }
    const grant = await authStore.consumeLoginGrant(body.code);
    if (!grant) {
      return c.json({ ok: false, error: "Login grant expired or was already used" }, 401);
    }
    const user = await directory.findActiveById(grant.userId);
    if (!user) {
      return c.json({ ok: false, error: "User is not active" }, 403);
    }
    c.header("cache-control", "no-store");
    return c.json({ ok: true, user, returnTo: grant.returnTo });
  });

  return routes;
}

export const slackAuthRoutes = createSlackAuthRoutes();
