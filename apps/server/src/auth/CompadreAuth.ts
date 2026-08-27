import * as DateTime from "effect/DateTime";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Cookies from "effect/unstable/http/Cookies";
import type { ClientOrchestrationCommand } from "@t3tools/contracts";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as SessionStore from "./SessionStore.ts";
import { deriveAuthClientMetadata } from "./utils.ts";

const CompadreLoginExchange = Schema.Struct({
  ok: Schema.Literal(true),
  user: Schema.Struct({
    id: Schema.String,
    displayName: Schema.String,
    realName: Schema.optional(Schema.String),
    avatarUrl: Schema.optional(Schema.String),
    email: Schema.optional(Schema.String),
  }),
  returnTo: Schema.String,
});
type CompadreLoginUser = typeof CompadreLoginExchange.Type.user;

const CompadreSessionSubject = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  avatarUrl: Schema.optional(Schema.String),
});

export function encodeCompadreUserSubject(user: CompadreLoginUser): string {
  return `compadre-user:${Buffer.from(
    JSON.stringify({
      id: user.id,
      displayName: user.displayName,
      ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
    }),
  ).toString("base64url")}`;
}

export function decodeCompadreUserSubject(subject: string) {
  if (!subject.startsWith("compadre-user:")) return null;
  try {
    return Schema.decodeUnknownSync(CompadreSessionSubject)(
      JSON.parse(Buffer.from(subject.slice("compadre-user:".length), "base64url").toString("utf8")),
    );
  } catch {
    return null;
  }
}

export function isCompadreAuthEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  const value = environment.COMPADRE_AUTH_ENABLED ?? environment.VITE_COMPADRE_AUTH_ENABLED ?? "";
  return value.trim().toLowerCase() === "true";
}

/**
 * Hosted Compadre must not inherit access from an older pairing-issued browser
 * cookie. Service/bearer sessions remain valid for the API and relay.
 */
export function isAllowedCompadreSession(
  session: { method: string; subject: string },
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isCompadreAuthEnabled(environment)) return true;
  if (session.method !== "browser-session-cookie") return true;
  return decodeCompadreUserSubject(session.subject) !== null;
}

export function attributeCompadreWebCommand(
  command: ClientOrchestrationCommand,
  subject: string,
): ClientOrchestrationCommand {
  const user = decodeCompadreUserSubject(subject);
  if (!user || command.type !== "thread.turn.start") return command;
  return {
    ...command,
    message: {
      ...command.message,
      attribution: {
        userId: user.id,
        displayName: user.displayName,
        ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
        origin: "web",
      },
    },
  };
}

export function normalizeCompadreReturnTo(value: string | null | undefined): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    return "/";
  }
  return value;
}

function configuration(): { controllerUrl: URL; serviceToken: string } | null {
  const rawControllerUrl = process.env.COMPADRE_CONTROLLER_URL?.trim();
  const serviceToken = process.env.COMPADRE_AUTH_EXCHANGE_SECRET?.trim();
  if (!rawControllerUrl || !serviceToken) return null;
  try {
    return { controllerUrl: new URL(rawControllerUrl), serviceToken };
  } catch {
    return null;
  }
}

export async function exchangeCompadreLoginGrant(input: {
  controllerUrl: URL;
  serviceToken: string;
  code: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}) {
  const endpoint = new URL("/internal/auth/exchange", input.controllerUrl);
  const response = await (input.fetch ?? globalThis.fetch)(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.serviceToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ code: input.code }),
  });
  if (!response.ok) throw new Error(`Compadre login exchange failed (${response.status})`);
  return Schema.decodeUnknownSync(CompadreLoginExchange)(await response.json());
}

class CompadreLoginExchangeError extends Data.TaggedError("CompadreLoginExchangeError")<{
  readonly cause: unknown;
}> {}

const compadreSlackStartRouteLayer = HttpRouter.add(
  "GET",
  "/auth/slack/start",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestUrl = HttpServerRequest.toURL(request);
    const config = configuration();
    if (Option.isNone(requestUrl) || !config) {
      return HttpServerResponse.text("Slack login is not configured.", { status: 503 });
    }
    const returnTo = normalizeCompadreReturnTo(requestUrl.value.searchParams.get("return_to"));
    const authorizationUrl = new URL("/auth/slack/start", config.controllerUrl);
    authorizationUrl.searchParams.set("return_to", returnTo);
    return HttpServerResponse.redirect(authorizationUrl.toString(), { status: 302 });
  }),
);

const compadreSlackCallbackRouteLayer = HttpRouter.add(
  "GET",
  "/auth/compadre/callback",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestUrl = HttpServerRequest.toURL(request);
    const config = configuration();
    const sessions = yield* SessionStore.SessionStore;
    if (Option.isNone(requestUrl) || !config) {
      return HttpServerResponse.text("Slack login is not configured.", { status: 503 });
    }
    const code = requestUrl.value.searchParams.get("code");
    if (!code) {
      return HttpServerResponse.text("Slack login code is missing.", { status: 400 });
    }
    const exchanged = yield* Effect.tryPromise({
      try: () => exchangeCompadreLoginGrant({ ...config, code }),
      catch: (cause) => new CompadreLoginExchangeError({ cause }),
    }).pipe(Effect.option);
    if (Option.isNone(exchanged)) {
      return HttpServerResponse.text("Slack login could not be completed.", { status: 401 });
    }
    const issued = yield* sessions.issue({
      subject: encodeCompadreUserSubject(exchanged.value.user),
      method: "browser-session-cookie",
      client: deriveAuthClientMetadata({ request }),
    });
    const cookies = yield* Effect.fromResult(
      Cookies.set(Cookies.empty, sessions.cookieName, issued.token, {
        expires: DateTime.toDate(issued.expiresAt),
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: requestUrl.value.protocol === "https:",
      }),
    );
    const response = HttpServerResponse.redirect(
      normalizeCompadreReturnTo(exchanged.value.returnTo),
      {
        status: 302,
        headers: { "cache-control": "no-store" },
      },
    );
    return HttpServerResponse.mergeCookies(response, cookies);
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Failed to issue Compadre browser session", { cause }).pipe(
        Effect.as(HttpServerResponse.text("Slack login could not be completed.", { status: 500 })),
      ),
    ),
  ),
);

const compadreLogoutRouteLayer = HttpRouter.add(
  "POST",
  "/auth/compadre/logout",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestUrl = HttpServerRequest.toURL(request);
    const sessions = yield* SessionStore.SessionStore;
    const token = request.cookies[sessions.cookieName];
    if (token) {
      yield* sessions.verify(token).pipe(
        Effect.flatMap((session) => sessions.revoke(session.sessionId)),
        Effect.ignore,
      );
    }
    const cookies = yield* Effect.fromResult(
      Cookies.expireCookie(Cookies.empty, sessions.cookieName, {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: Option.isSome(requestUrl) && requestUrl.value.protocol === "https:",
      }),
    );
    return HttpServerResponse.mergeCookies(
      HttpServerResponse.empty({ status: 204, headers: { "cache-control": "no-store" } }),
      cookies,
    );
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Failed to revoke Compadre browser session", { cause }).pipe(
        Effect.as(HttpServerResponse.empty({ status: 500 })),
      ),
    ),
  ),
);

export const compadreAuthRouteLayer = Layer.mergeAll(
  compadreSlackStartRouteLayer,
  compadreSlackCallbackRouteLayer,
  compadreLogoutRouteLayer,
);
