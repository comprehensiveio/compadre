import { CompadreReadyPreviews } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as SessionStore from "./SessionStore.ts";
import { isAllowedCompadreSession } from "./CompadreAuth.ts";
import { compadreOperationsConfiguration } from "./CompadreOperations.ts";

const decodeReadyPreviews = Schema.decodeUnknownSync(CompadreReadyPreviews);

export async function fetchCompadreReadyPreviews(input: {
  config: NonNullable<ReturnType<typeof compadreOperationsConfiguration>>;
  fetch?: typeof globalThis.fetch;
}) {
  const response = await (input.fetch ?? globalThis.fetch)(
    new URL("/internal/previews/ready", input.config.controllerUrl),
    {
      headers: { authorization: `Bearer ${input.config.serviceToken}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  // Allows the web and controller to deploy independently.
  if (response.status === 404) return { previews: [] };
  if (!response.ok) throw new Error(`Preview readiness failed (${response.status})`);
  return decodeReadyPreviews(await response.json());
}

export const compadrePreviewsRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const sessions = yield* SessionStore.SessionStore;
    return HttpRouter.add(
      "GET",
      "/api/compadre/previews/ready",
      Effect.gen(function* () {
        const config = compadreOperationsConfiguration();
        if (!config) return HttpServerResponse.empty({ status: 404 });
        const request = yield* HttpServerRequest.HttpServerRequest;
        const token = request.cookies[sessions.cookieName];
        const verified = token ? yield* sessions.verify(token).pipe(Effect.option) : Option.none();
        if (Option.isNone(verified) || !isAllowedCompadreSession(verified.value)) {
          return HttpServerResponse.jsonUnsafe(
            { error: "Authentication required" },
            { status: 401 },
          );
        }
        const snapshot = yield* Effect.tryPromise(() =>
          fetchCompadreReadyPreviews({ config }),
        ).pipe(Effect.option);
        return HttpServerResponse.jsonUnsafe(
          Option.isSome(snapshot) ? snapshot.value : { previews: [] },
          { headers: { "cache-control": "no-store" } },
        );
      }),
    );
  }),
);
