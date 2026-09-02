import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as SessionStore from "./SessionStore.ts";
import {
  decodeCompadreUserSubject,
  isAllowedCompadreSession,
  isCompadreAuthEnabled,
} from "./CompadreAuth.ts";
import { compadreOperationsConfiguration } from "./CompadreOperations.ts";

/**
 * Same-origin proxy for the Compadre controller's triggered-prompts API.
 * The browser talks to these /api/triggered-prompts/* routes with its session
 * cookie; the server forwards to the controller bearing the service key it
 * already holds for the operations page, which never reaches the client.
 * Fork-owned file — registered through one hook in server.ts.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type ProxyAction = "list" | "create" | "update" | "enable" | "delete" | "run";

function jsonResponse(body: unknown, status: number) {
  return HttpServerResponse.text(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * Maps a proxy action to the controller request. `requestBody` is the parsed
 * browser JSON; `userId` is the acting canonical user id when known.
 */
export function controllerRequestFor(
  action: ProxyAction,
  requestBody: Record<string, unknown>,
  userId: string | undefined,
): { method: "GET" | "POST"; path: string; body?: unknown } | { error: string } {
  if (action === "list") return { method: "GET", path: "/triggers/api/prompts" };
  if (action === "create") {
    return {
      method: "POST",
      path: "/triggers/api/prompts",
      body: { ...requestBody, ...(userId ? { createdBy: userId } : {}) },
    };
  }
  const { id, ...rest } = requestBody;
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
    return { error: "id must be a triggered prompt UUID" };
  }
  switch (action) {
    case "update":
      return { method: "POST", path: `/triggers/api/prompts/${id}`, body: rest };
    case "enable":
      return { method: "POST", path: `/triggers/api/prompts/${id}/enable`, body: rest };
    case "delete":
      return { method: "POST", path: `/triggers/api/prompts/${id}/delete`, body: {} };
    case "run":
      return { method: "POST", path: `/triggers/api/prompts/${id}/run`, body: {} };
  }
}

async function forwardToController(input: {
  controllerUrl: URL;
  serviceToken: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  fetch?: typeof globalThis.fetch;
}): Promise<{ status: number; body: unknown }> {
  const response = await (input.fetch ?? globalThis.fetch)(
    new URL(input.path, input.controllerUrl),
    {
      method: input.method,
      headers: {
        authorization: `Bearer ${input.serviceToken}`,
        ...(input.method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(input.method === "POST" ? { body: JSON.stringify(input.body ?? {}) } : {}),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const body: unknown = await response
    .json()
    .catch(() => ({ error: `Controller responded ${response.status}` }));
  return { status: response.status, body };
}

export const compadreTriggeredPromptsRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const sessions = yield* SessionStore.SessionStore;
    const triggeredPromptsRoute = (action: ProxyAction) =>
      HttpRouter.add(
        action === "list" ? "GET" : "POST",
        `/api/triggered-prompts/${action}`,
        Effect.gen(function* () {
          const config = compadreOperationsConfiguration();
          if (!config) {
            return jsonResponse({ error: "Triggered prompts are not configured." }, 503);
          }
          const request = yield* HttpServerRequest.HttpServerRequest;

          // Resolve the acting user from the browser session. When hosted
          // auth is disabled (local/desktop dev) the routes stay reachable
          // but unattributed, matching the operations proxy.
          let userId: string | undefined;
          if (isCompadreAuthEnabled()) {
            const token = request.cookies[sessions.cookieName];
            const verified = token
              ? yield* sessions.verify(token).pipe(Effect.option)
              : Option.none();
            if (Option.isNone(verified) || !isAllowedCompadreSession(verified.value)) {
              return jsonResponse({ error: "Authentication required" }, 401);
            }
            userId = decodeCompadreUserSubject(verified.value.subject)?.id;
            if (!userId) {
              return jsonResponse({ error: "Authentication required" }, 401);
            }
          }

          const requestBody =
            action === "list"
              ? {}
              : ((yield* request.json.pipe(Effect.orElseSucceed(() => ({})))) as Record<
                  string,
                  unknown
                >);
          const controllerRequest = controllerRequestFor(action, requestBody, userId);
          if ("error" in controllerRequest) {
            return jsonResponse({ error: controllerRequest.error }, 400);
          }

          const result = yield* Effect.tryPromise(() =>
            forwardToController({ ...config, ...controllerRequest }),
          ).pipe(Effect.option);
          if (Option.isNone(result)) {
            return jsonResponse({ error: "Triggered prompts request failed." }, 502);
          }
          return jsonResponse(result.value.body, result.value.status);
        }),
      );
    return Layer.mergeAll(
      triggeredPromptsRoute("list"),
      triggeredPromptsRoute("create"),
      triggeredPromptsRoute("update"),
      triggeredPromptsRoute("enable"),
      triggeredPromptsRoute("delete"),
      triggeredPromptsRoute("run"),
    );
  }),
);
