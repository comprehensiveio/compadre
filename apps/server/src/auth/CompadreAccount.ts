import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  HttpBody,
  HttpClient,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import * as SessionStore from "./SessionStore.ts";
import {
  decodeCompadreUserSubject,
  isAllowedCompadreSession,
  isCompadreAuthEnabled,
} from "./CompadreAuth.ts";
import { compadreOperationsConfiguration } from "./CompadreOperations.ts";

/**
 * Same-origin proxy for the signed-in hosted user's own profile. The browser
 * session cookie identifies the user; the controller path is derived from
 * that id, so a client can never read or edit anyone else's record. Today
 * the only editable field is the GitHub username used to credit the
 * requester on worker commits. Fork-owned file — registered in server.ts.
 */

function jsonResponse(body: unknown, status: number) {
  return HttpServerResponse.text(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const forwardToController = (input: {
  controllerUrl: URL;
  serviceToken: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const url = new URL(input.path, input.controllerUrl).toString();
    const headers = { authorization: `Bearer ${input.serviceToken}` };
    const response =
      input.method === "GET"
        ? yield* httpClient.get(url, { headers })
        : yield* httpClient.post(url, {
            headers,
            body: HttpBody.jsonUnsafe(input.body ?? {}),
          });
    const body: unknown = yield* response.json.pipe(
      Effect.orElseSucceed(() => ({ error: `Controller responded ${response.status}` })),
    );
    return { status: response.status, body };
  });

export const compadreAccountRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const sessions = yield* SessionStore.SessionStore;
    const accountProfileRoute = (method: "GET" | "POST") =>
      HttpRouter.add(
        method,
        "/api/account/profile",
        Effect.gen(function* () {
          const config = compadreOperationsConfiguration();
          if (!config) return jsonResponse({ error: "Hosted accounts are not configured." }, 503);
          if (!isCompadreAuthEnabled()) {
            return jsonResponse({ error: "Authentication required" }, 401);
          }
          const request = yield* HttpServerRequest.HttpServerRequest;
          const token = request.cookies[sessions.cookieName];
          const verified = token
            ? yield* sessions.verify(token).pipe(Effect.option)
            : Option.none();
          if (Option.isNone(verified) || !isAllowedCompadreSession(verified.value)) {
            return jsonResponse({ error: "Authentication required" }, 401);
          }
          const userId = decodeCompadreUserSubject(verified.value.subject)?.id;
          if (!userId) return jsonResponse({ error: "Authentication required" }, 401);

          const body =
            method === "GET"
              ? undefined
              : ((yield* request.json.pipe(Effect.orElseSucceed(() => ({})))) as Record<
                  string,
                  unknown
                >);
          const result = yield* forwardToController({
            ...config,
            method,
            path: `/internal/users/${encodeURIComponent(userId)}/profile`,
            ...(body ? { body: { githubLogin: body.githubLogin ?? "" } } : {}),
          }).pipe(Effect.option);
          if (Option.isNone(result)) {
            return jsonResponse({ error: "Account request failed." }, 502);
          }
          return jsonResponse(result.value.body, result.value.status);
        }),
      );
    return Layer.mergeAll(accountProfileRoute("GET"), accountProfileRoute("POST"));
  }),
);
