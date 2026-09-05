import {
  type MessageAttribution,
  type ProviderDriverKind,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sse from "effect/unstable/encoding/Sse";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { ProviderAdapterRequestError } from "../Errors.ts";

const COMPADRE_T3_PROTOCOL_HEADER = "X-Compadre-T3-Protocol-Version";
const COMPADRE_T3_PROTOCOL_VERSION = "2";
const MAX_RECONNECT_DELAY_MS = 5_000;

export interface CompadreTurnRequest {
  readonly endpoint: string;
  readonly apiKey: string | undefined;
  readonly threadId: string;
  readonly runId: string;
  readonly messageId: string;
  readonly input: string;
  readonly inputFiles: ReadonlyArray<{
    readonly name: string;
    readonly mimetype: string;
    readonly sizeBytes: number;
    readonly dataBase64: string;
  }>;
  readonly provider: "claude-code" | "codex" | undefined;
  readonly model: string | undefined;
  readonly modelOptions: ReadonlyArray<ProviderOptionSelection>;
  readonly attribution: MessageAttribution | undefined;
}

export type CompadreStreamEvent = Readonly<Record<string, unknown>> & {
  readonly type: string;
};

export type CompadreTransport = (
  request: CompadreTurnRequest,
) => Stream.Stream<CompadreStreamEvent, ProviderAdapterRequestError>;

export interface CompadreCancelRequest {
  readonly endpoint: string;
  readonly apiKey: string | undefined;
  readonly runId: string;
}

export type CompadreCancelTransport = (
  request: CompadreCancelRequest,
) => Effect.Effect<void, ProviderAdapterRequestError>;

export type CompadreSteerTransport = (input: {
  endpoint: string;
  apiKey: string | undefined;
  runId: string;
  id: string;
  text: string;
}) => Effect.Effect<"accepted" | "unsupported", ProviderAdapterRequestError>;

/**
 * Durable HTTP adapter for the Compadre controller protocol.
 *
 * The initial POST starts or joins an idempotent run. If delivery ends before
 * a terminal event, later GETs resume from the last SSE id. The controller's
 * Postgres log is authoritative, so reconnecting never repeats acknowledged
 * deltas.
 */
export function makeCompadreTransport(
  httpClient: HttpClient.HttpClient,
  runtimeProvider: ProviderDriverKind,
  reconnectBaseDelayMs = 250,
): CompadreTransport {
  return (input) => {
    const body = {
      threadId: input.threadId,
      runId: input.runId,
      messages: [{ id: input.messageId, role: "user", content: input.input }],
      tools: [],
      context: [],
      forwardedProps: {
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.modelOptions.length > 0 ? { modelOptions: input.modelOptions } : {}),
        ...(input.attribution ? { attribution: input.attribution } : {}),
        ...(input.inputFiles.length > 0 ? { inputFiles: input.inputFiles } : {}),
      },
      state: {},
    };
    let lastEventId: string | undefined;
    let connected = false;
    let terminal = false;
    let reconnectAttempt = 0;

    const requestFor = (initial: boolean) => {
      const eventsUrl = new URL(input.endpoint);
      if (!initial) {
        eventsUrl.pathname = eventsUrl.pathname.replace(
          /\/chat\/?$/u,
          `/runs/${encodeURIComponent(input.runId)}/events`,
        );
        if (!lastEventId) eventsUrl.searchParams.set("offset", "-1");
      }
      let request = initial
        ? HttpClientRequest.post(eventsUrl.toString(), {
            body: HttpBody.jsonUnsafe(body),
          })
        : HttpClientRequest.get(eventsUrl.toString());
      request = request.pipe(
        HttpClientRequest.setHeader("accept", "text/event-stream"),
        HttpClientRequest.setHeader(COMPADRE_T3_PROTOCOL_HEADER, COMPADRE_T3_PROTOCOL_VERSION),
      );
      if (lastEventId) {
        request = request.pipe(HttpClientRequest.setHeader("last-event-id", lastEventId));
      }
      if (input.apiKey) {
        request = request.pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${input.apiKey}`),
        );
      }
      return request;
    };

    const open = (initial: boolean): ReturnType<CompadreTransport> =>
      Stream.unwrap(
        httpClient.execute(requestFor(initial)).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.map((response) => {
            connected = true;
            return response.stream.pipe(
              Stream.decodeText(),
              Stream.pipeThroughChannel(Sse.decode()),
              Stream.filter((event) => event.data !== "[DONE]"),
              Stream.mapEffect((event) =>
                Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(event.data).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapterRequestError({
                        provider: runtimeProvider,
                        method: "compadre/sse",
                        detail: "Compadre emitted invalid JSON in its event stream.",
                        cause,
                      }),
                  ),
                  Effect.flatMap((value) => {
                    if (event.id) lastEventId = event.id;
                    if (Predicate.isObject(value) && typeof value.type === "string") {
                      reconnectAttempt = 0;
                      if (value.type === "RUN_FINISHED" || value.type === "RUN_ERROR") {
                        terminal = true;
                      }
                      return Effect.succeed(value as CompadreStreamEvent);
                    }
                    return Effect.fail(
                      new ProviderAdapterRequestError({
                        provider: runtimeProvider,
                        method: "compadre/sse",
                        detail: "Compadre emitted an event without a type.",
                      }),
                    );
                  }),
                ),
              ),
            );
          }),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: runtimeProvider,
                method: "compadre/chat",
                detail: "Could not open the Compadre event stream.",
                cause,
              }),
          ),
        ),
      ).pipe(
        Stream.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: runtimeProvider,
              method: "compadre/chat",
              detail: "The Compadre event stream failed.",
              cause,
            }),
        ),
      );

    const reconnect = (): ReturnType<CompadreTransport> => {
      const delayMs = Math.min(
        reconnectBaseDelayMs * 2 ** reconnectAttempt,
        MAX_RECONNECT_DELAY_MS,
      );
      reconnectAttempt += 1;
      if (delayMs === 0) return Stream.suspend(() => loop(false));
      return Stream.fromEffectDrain(Effect.sleep(`${delayMs} millis`)).pipe(
        Stream.concat(Stream.suspend(() => loop(false))),
      );
    };

    const loop = (initial: boolean): ReturnType<CompadreTransport> =>
      open(initial).pipe(
        Stream.concat(Stream.suspend(() => (terminal ? Stream.empty : reconnect()))),
        Stream.catchCause((cause) => {
          if (terminal) return Stream.empty;
          if (Cause.hasInterruptsOnly(cause)) return Stream.failCause(cause);
          if (initial && !connected) return Stream.failCause(cause);
          return reconnect();
        }),
      );

    return loop(true);
  };
}

function cancelEndpoint(endpoint: string, runId: string): string {
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/\/chat\/?$/u, `/runs/${encodeURIComponent(runId)}/cancel`);
  return url.toString();
}

export function makeCompadreCancelTransport(
  httpClient: HttpClient.HttpClient,
  runtimeProvider: ProviderDriverKind,
): CompadreCancelTransport {
  return (input) => {
    let request = HttpClientRequest.post(cancelEndpoint(input.endpoint, input.runId));
    if (input.apiKey) {
      request = request.pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${input.apiKey}`),
      );
    }
    return httpClient.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.asVoid,
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: runtimeProvider,
            method: "compadre/cancel",
            detail: "Could not cancel the active Compadre run.",
            cause,
          }),
      ),
    );
  };
}

/**
 * Send follow-up input to the durable run that already owns the provider
 * turn. `unsupported` is reserved for the cross-service rollout window, when
 * an older controller still expects steering as a second `/chat` request.
 */
export function makeCompadreSteerTransport(
  httpClient: HttpClient.HttpClient,
  runtimeProvider: ProviderDriverKind,
): CompadreSteerTransport {
  return (input) => {
    const url = new URL(cancelEndpoint(input.endpoint, input.runId));
    url.pathname = url.pathname.replace(/\/cancel$/u, "/steer");
    let request = HttpClientRequest.post(url.toString(), {
      body: HttpBody.jsonUnsafe({ id: input.id, text: input.text }),
    });
    if (input.apiKey) {
      request = request.pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${input.apiKey}`),
      );
    }
    return httpClient.execute(request).pipe(
      Effect.flatMap((response) =>
        response.status === 404 || response.status === 405
          ? Effect.succeed("unsupported" as const)
          : HttpClientResponse.filterStatusOk(response).pipe(Effect.as("accepted" as const)),
      ),
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: runtimeProvider,
            method: "compadre/steer",
            detail:
              "The active turn could not accept this message. Send it again after the turn stops.",
            cause,
          }),
      ),
    );
  };
}
