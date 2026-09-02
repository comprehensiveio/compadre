import assert from "node:assert/strict";
import test from "node:test";
import {
  createSlackAuthRoutes,
  type SlackAuthDependencies,
} from "./slack-auth.js";
import type { SlackUserIdentityInput } from "../services/user-directory.js";

const environment = {
  SLACK_CLIENT_ID: "client-1",
  SLACK_CLIENT_SECRET: "client-secret",
  SLACK_OIDC_REDIRECT_URI: "https://controller.example/auth/slack/callback",
  COMPADRE_T3_CENTRAL_URL: "https://t3.example",
  COMPADRE_SLACK_WORKSPACE_ID: "T123",
  COMPADRE_AUTH_EXCHANGE_SECRET: "service-token",
};

function dependencies(): SlackAuthDependencies {
  return {
    environment,
    fetch: async () =>
      new Response(JSON.stringify({ ok: true, id_token: "id-token" }), {
        headers: { "content-type": "application/json" },
      }),
    verifyIdToken: async () => ({
      iss: "https://slack.com",
      aud: "client-1",
      nonce: "nonce-1",
      sub: "U123",
      name: "Isaac Sherrill",
      email: "isaac@example.com",
      picture: "https://example.com/isaac.png",
      "https://slack.com/team_id": "T123",
      "https://slack.com/user_id": "U123",
    }),
    getAuthStore: async () => ({
      beginSlackLogin: async (returnTo?: string) => ({
        state: "state-1",
        nonce: "nonce-1",
        returnTo: returnTo ?? "/",
      }),
      consumeSlackLogin: async (state: string) =>
        state === "state-1"
          ? { nonce: "nonce-1", returnTo: "/env/thread" }
          : null,
      issueLoginGrant: async () => "grant-12345678901234567890",
      consumeLoginGrant: async (code: string) =>
        code === "grant-12345678901234567890"
          ? { userId: "54fdda5d-6b65-518e-92fa-841b762342df", returnTo: "/env/thread" }
          : null,
    }),
    getUserDirectory: async () => ({
      upsertSlackIdentity: async () => ({
        id: "54fdda5d-6b65-518e-92fa-841b762342df",
        displayName: "Isaac Sherrill",
        avatarUrl: "https://example.com/isaac.png",
        email: "isaac@example.com",
      }),
      findActiveById: async () => ({
        id: "54fdda5d-6b65-518e-92fa-841b762342df",
        displayName: "Isaac Sherrill",
        avatarUrl: "https://example.com/isaac.png",
        email: "isaac@example.com",
      }),
    }),
  };
}

test("starts a workspace-scoped Slack OpenID flow", async () => {
  const routes = createSlackAuthRoutes(dependencies());
  const response = await routes.request(
    "https://controller.example/auth/slack/start?return_to=%2Fenv%2Fthread",
  );
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location")!);
  assert.equal(location.origin, "https://slack.com");
  assert.equal(location.pathname, "/openid/connect/authorize");
  assert.equal(location.searchParams.get("scope"), "openid profile email");
  assert.equal(location.searchParams.get("team"), "T123");
  assert.equal(location.searchParams.get("state"), "state-1");
  assert.equal(location.searchParams.get("nonce"), "nonce-1");
  assert.equal(location.searchParams.has("code_challenge"), false);
});

test("provisions the Slack identity and redirects with only a one-time grant", async () => {
  let identity: unknown;
  const deps = dependencies();
  const baseDirectory = await dependencies().getUserDirectory();
  assert.ok(baseDirectory);
  deps.getUserDirectory = async () => ({
    ...baseDirectory,
    upsertSlackIdentity: async (input: SlackUserIdentityInput) => {
      identity = input;
      return {
        id: "54fdda5d-6b65-518e-92fa-841b762342df",
        displayName: "Isaac Sherrill",
      };
    },
  });
  const routes = createSlackAuthRoutes(deps);
  const response = await routes.request(
    "https://controller.example/auth/slack/callback?state=state-1&code=slack-code",
  );
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location")!);
  assert.equal(location.origin, "https://t3.example");
  assert.equal(location.pathname, "/auth/compadre/callback");
  assert.equal(location.searchParams.get("code"), "grant-12345678901234567890");
  assert.deepEqual(identity, {
    workspaceId: "T123",
    slackUserId: "U123",
    displayName: "Isaac Sherrill",
    realName: "Isaac Sherrill",
    avatarUrl: "https://example.com/isaac.png",
    email: "isaac@example.com",
  });
});

test("exchanges a grant only for the authenticated T3 service", async () => {
  const routes = createSlackAuthRoutes(dependencies());
  const unauthorized = await routes.request("https://controller.example/internal/auth/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "grant-12345678901234567890" }),
  });
  assert.equal(unauthorized.status, 401);

  const response = await routes.request("https://controller.example/internal/auth/exchange", {
    method: "POST",
    headers: {
      authorization: "Bearer service-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ code: "grant-12345678901234567890" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    user: {
      id: "54fdda5d-6b65-518e-92fa-841b762342df",
      displayName: "Isaac Sherrill",
      avatarUrl: "https://example.com/isaac.png",
      email: "isaac@example.com",
    },
    returnTo: "/env/thread",
  });
});
