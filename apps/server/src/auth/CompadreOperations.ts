import { CompadreThreadOperationsSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as SessionStore from "./SessionStore.ts";
import { isAllowedCompadreSession } from "./CompadreAuth.ts";

interface CompadreOperationsConfiguration {
  readonly controllerUrl: URL;
  readonly serviceToken: string;
}

export function compadreOperationsConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): CompadreOperationsConfiguration | null {
  const controllerUrl = environment.COMPADRE_CONTROLLER_URL?.trim();
  const serviceToken = environment.COMPADRE_API_KEY?.trim();
  if (!controllerUrl || !serviceToken) return null;
  try {
    return { controllerUrl: new URL(controllerUrl), serviceToken };
  } catch {
    return null;
  }
}

export async function fetchCompadreThreadOperations(input: {
  readonly config: CompadreOperationsConfiguration;
  readonly fetch?: (url: URL, init?: RequestInit) => Promise<Response>;
}) {
  const endpoint = new URL("/internal/operations/threads", input.config.controllerUrl);
  const response = await (input.fetch ?? globalThis.fetch)(endpoint, {
    headers: { authorization: `Bearer ${input.config.serviceToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Compadre operations request failed (${response.status})`);
  }
  return Schema.decodeUnknownSync(CompadreThreadOperationsSnapshot)(await response.json());
}

export const compadreOperationsRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const sessions = yield* SessionStore.SessionStore;
    return HttpRouter.add(
      "GET",
      "/api/compadre/operations/threads",
      Effect.gen(function* () {
        const config = compadreOperationsConfiguration();
        if (!config) return HttpServerResponse.empty({ status: 404 });

        const request = yield* HttpServerRequest.HttpServerRequest;
        const token = request.cookies[sessions.cookieName];
        const verified = token ? yield* sessions.verify(token).pipe(Effect.option) : Option.none();
        if (Option.isNone(verified) || !isAllowedCompadreSession(verified.value)) {
          return HttpServerResponse.jsonUnsafe(
            { error: "Authentication required" },
            { status: 401, headers: { "cache-control": "no-store" } },
          );
        }

        const snapshot = yield* Effect.tryPromise(() =>
          fetchCompadreThreadOperations({ config }),
        ).pipe(Effect.option);
        if (Option.isNone(snapshot)) {
          return HttpServerResponse.jsonUnsafe(
            { error: "Thread operations are temporarily unavailable" },
            { status: 502, headers: { "cache-control": "no-store" } },
          );
        }
        return HttpServerResponse.jsonUnsafe(snapshot.value, {
          headers: { "cache-control": "no-store" },
        });
      }),
    );
  }),
);
