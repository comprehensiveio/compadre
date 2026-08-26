import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sse from "effect/unstable/encoding/Sse";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";

const PROVIDER = ProviderDriverKind.make("compadre");

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

export interface CompadreAdapterOptions {
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly instanceId?: ProviderInstanceId;
  readonly provider?: "claude-code" | "codex";
  /** Provider identity presented to T3 orchestration. Defaults to `compadre`. */
  readonly runtimeProvider?: ProviderDriverKind;
  readonly transport?: CompadreTransport;
  readonly cancelTransport?: CompadreCancelTransport;
  readonly attachmentsDir?: string;
}

interface CompadreSessionContext {
  session: ProviderSession;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeFiber: Fiber.Fiber<void, ProviderAdapterRequestError> | undefined;
  activeRunId: string | undefined;
  stopped: boolean;
}

function isCompadreProvider(value: string | undefined): value is "claude-code" | "codex" {
  return value === "claude-code" || value === "codex";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(event: CompadreStreamEvent, field: string): string | undefined {
  const value = event[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function makeLiveTransport(
  httpClient: HttpClient.HttpClient,
  runtimeProvider: ProviderDriverKind,
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
        ...(input.inputFiles.length > 0 ? { inputFiles: input.inputFiles } : {}),
      },
      state: {},
    };
    let request = HttpClientRequest.post(input.endpoint, {
      body: HttpBody.jsonUnsafe(body),
    }).pipe(HttpClientRequest.setHeader("accept", "text/event-stream"));
    if (input.apiKey) {
      request = request.pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${input.apiKey}`),
      );
    }

    return Stream.unwrap(
      httpClient.execute(request).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.map((response) =>
          response.stream.pipe(
            Stream.decodeText(),
            Stream.pipeThroughChannel(Sse.decode()),
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
                Effect.flatMap((value) =>
                  isRecord(value) && typeof value.type === "string"
                    ? Effect.succeed(value as CompadreStreamEvent)
                    : Effect.fail(
                        new ProviderAdapterRequestError({
                          provider: runtimeProvider,
                          method: "compadre/sse",
                          detail: "Compadre emitted an event without a type.",
                        }),
                      ),
                ),
              ),
            ),
          ),
        ),
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
  };
}

function cancelEndpoint(endpoint: string, runId: string): string {
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/\/chat\/?$/u, `/runs/${encodeURIComponent(runId)}/cancel`);
  return url.toString();
}

function makeLiveCancelTransport(
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

export function makeCompadreAdapter(options: CompadreAdapterOptions) {
  return Effect.gen(function* () {
    const runtimeProvider = options.runtimeProvider ?? PROVIDER;
    const boundInstanceId = options.instanceId ?? ProviderInstanceId.make("compadre");
    const crypto = yield* Crypto.Crypto;
    const adapterScope = yield* Scope.make("sequential");
    const httpClient = yield* HttpClient.HttpClient;
    const fileSystem = yield* FileSystem.FileSystem;
    const transport = options.transport ?? makeLiveTransport(httpClient, runtimeProvider);
    const cancelTransport =
      options.cancelTransport ?? makeLiveCancelTransport(httpClient, runtimeProvider);
    const sessions = new Map<ThreadId, CompadreSessionContext>();
    const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomId = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: runtimeProvider,
            method: "crypto/randomUUIDv4",
            detail: "Failed to create a Compadre runtime identifier.",
            cause,
          }),
      ),
    );
    const makeEventStamp = () =>
      Effect.all({
        eventId: Effect.map(randomId, EventId.make),
        createdAt: nowIso,
      });
    const publish = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEvents, event).pipe(Effect.asVoid);

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<CompadreSessionContext, ProviderAdapterSessionNotFoundError> => {
      const context = sessions.get(threadId);
      return context && !context.stopped
        ? Effect.succeed(context)
        : Effect.fail(
            new ProviderAdapterSessionNotFoundError({ provider: runtimeProvider, threadId }),
          );
    };

    const setSessionReady = (context: CompadreSessionContext) =>
      Effect.gen(function* () {
        const { activeTurnId: _activeTurnId, ...session } = context.session;
        context.session = { ...session, status: "ready", updatedAt: yield* nowIso };
        context.activeRunId = undefined;
      });

    const cancelActiveRun = (context: CompadreSessionContext) =>
      context.activeRunId
        ? cancelTransport({
            endpoint: options.endpoint,
            apiKey: options.apiKey,
            runId: context.activeRunId,
          })
        : Effect.void;

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== runtimeProvider) {
          return yield* new ProviderAdapterValidationError({
            provider: runtimeProvider,
            operation: "startSession",
            issue: `Expected provider '${runtimeProvider}' but received '${input.provider}'.`,
          });
        }
        const existing = sessions.get(input.threadId);
        if (existing?.activeFiber) yield* Fiber.interrupt(existing.activeFiber);

        const now = yield* nowIso;
        const session: ProviderSession = {
          provider: runtimeProvider,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.modelSelection?.instanceId === boundInstanceId && input.modelSelection.model
            ? { model: input.modelSelection.model }
            : options.provider
              ? { model: options.provider }
              : {}),
          threadId: input.threadId,
          resumeCursor: { transport: "compadre", threadId: input.threadId },
          createdAt: now,
          updatedAt: now,
        };
        sessions.set(input.threadId, {
          session,
          turns: [],
          activeFiber: undefined,
          activeRunId: undefined,
          stopped: false,
        });
        yield* publish({
          type: "session.started",
          ...(yield* makeEventStamp()),
          provider: runtimeProvider,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          payload: { message: "Compadre Modal session ready" },
        });
        yield* publish({
          type: "session.state.changed",
          ...(yield* makeEventStamp()),
          provider: runtimeProvider,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          payload: { state: "ready", reason: "Connected to Compadre" },
        });
        yield* publish({
          type: "thread.started",
          ...(yield* makeEventStamp()),
          provider: runtimeProvider,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          payload: { providerThreadId: input.threadId },
        });
        return session;
      });

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        const attachments = input.attachments ?? [];
        const text =
          input.input?.trim() ||
          (attachments.length > 0 ? "Please inspect the attached image(s)." : undefined);
        if (!text) {
          return yield* new ProviderAdapterValidationError({
            provider: runtimeProvider,
            operation: "sendTurn",
            issue: "A non-empty text input is required for the Compadre experiment.",
          });
        }
        const inputFiles = yield* Effect.forEach(attachments, (attachment) =>
          Effect.gen(function* () {
            if (!options.attachmentsDir) {
              return yield* new ProviderAdapterValidationError({
                provider: runtimeProvider,
                operation: "sendTurn",
                issue: "The Compadre attachment directory is not configured.",
              });
            }
            if (
              !["image/gif", "image/jpeg", "image/png", "image/webp"].includes(attachment.mimeType)
            ) {
              return yield* new ProviderAdapterValidationError({
                provider: runtimeProvider,
                operation: "sendTurn",
                issue: `Unsupported Compadre image attachment type '${attachment.mimeType}'.`,
              });
            }
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: options.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterValidationError({
                provider: runtimeProvider,
                operation: "sendTurn",
                issue: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: runtimeProvider,
                    method: "compadre/attachment",
                    detail: "Failed to read a Compadre attachment file.",
                    cause,
                  }),
              ),
            );
            return {
              name: attachment.name,
              mimetype: attachment.mimeType,
              sizeBytes: bytes.byteLength,
              dataBase64: Buffer.from(bytes).toString("base64"),
            };
          }),
        );
        if (context.activeFiber) {
          return yield* new ProviderAdapterValidationError({
            provider: runtimeProvider,
            operation: "sendTurn",
            issue: "A Compadre turn is already running for this thread.",
          });
        }

        const selectedModel =
          input.modelSelection?.instanceId === boundInstanceId
            ? input.modelSelection.model
            : context.session.model;
        const selectedProvider = isCompadreProvider(selectedModel)
          ? selectedModel
          : options.provider;

        const turnId = TurnId.make(yield* randomId);
        const runId = yield* randomId;
        const messageId = yield* randomId;
        context.turns.push({ id: turnId, items: [] });
        context.activeRunId = runId;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          ...(selectedProvider ? { model: selectedProvider } : {}),
          updatedAt: yield* nowIso,
        };
        yield* publish({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: runtimeProvider,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          turnId,
          payload: context.session.model ? { model: context.session.model } : {},
        });

        const worker = Effect.gen(function* () {
          const items = new Map<
            string,
            {
              readonly id: RuntimeItemId;
              readonly type: "assistant_message" | "mcp_tool_call";
              readonly title?: string;
            }
          >();
          let terminal = false;

          const completeTurn = (
            state: "completed" | "failed" | "cancelled",
            errorMessage?: string,
          ) =>
            Effect.gen(function* () {
              if (terminal) return;
              terminal = true;
              yield* setSessionReady(context);
              yield* publish({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: runtimeProvider,
                providerInstanceId: boundInstanceId,
                threadId: input.threadId,
                turnId,
                payload: {
                  state,
                  ...(errorMessage ? { errorMessage } : {}),
                },
              });
              yield* publish({
                type: "session.state.changed",
                ...(yield* makeEventStamp()),
                provider: runtimeProvider,
                providerInstanceId: boundInstanceId,
                threadId: input.threadId,
                payload: {
                  state: "ready",
                  reason: `Compadre turn ${state}`,
                },
              });
            });

          const completeOpenItems = () =>
            Effect.forEach(
              Array.from(items.entries()),
              ([key, item]) =>
                Effect.gen(function* () {
                  yield* publish({
                    type: "item.completed",
                    ...(yield* makeEventStamp()),
                    provider: runtimeProvider,
                    providerInstanceId: boundInstanceId,
                    threadId: input.threadId,
                    turnId,
                    itemId: item.id,
                    payload: {
                      itemType: item.type,
                      status: "completed",
                      ...(item.title ? { title: item.title } : {}),
                    },
                  });
                  items.delete(key);
                }),
              { discard: true },
            );

          const failTurn = (message: string) =>
            Effect.gen(function* () {
              if (terminal) return;
              yield* publish({
                type: "runtime.error",
                ...(yield* makeEventStamp()),
                provider: runtimeProvider,
                providerInstanceId: boundInstanceId,
                threadId: input.threadId,
                turnId,
                payload: { message, class: "transport_error" },
              });
              yield* completeTurn("failed", message);
            });

          const handleEvent = (event: CompadreStreamEvent) =>
            Effect.gen(function* () {
              switch (event.type) {
                case "TEXT_MESSAGE_START": {
                  const sourceId = stringField(event, "messageId") ?? `assistant-${runId}`;
                  if (items.has(sourceId)) return;
                  const itemId = RuntimeItemId.make(sourceId);
                  items.set(sourceId, { id: itemId, type: "assistant_message" });
                  yield* publish({
                    type: "item.started",
                    ...(yield* makeEventStamp()),
                    provider: runtimeProvider,
                    providerInstanceId: boundInstanceId,
                    threadId: input.threadId,
                    turnId,
                    itemId,
                    payload: { itemType: "assistant_message", status: "inProgress" },
                  });
                  return;
                }
                case "TEXT_MESSAGE_CONTENT": {
                  const sourceId = stringField(event, "messageId") ?? `assistant-${runId}`;
                  let item = items.get(sourceId);
                  if (!item) {
                    item = { id: RuntimeItemId.make(sourceId), type: "assistant_message" };
                    items.set(sourceId, item);
                    yield* publish({
                      type: "item.started",
                      ...(yield* makeEventStamp()),
                      provider: runtimeProvider,
                      providerInstanceId: boundInstanceId,
                      threadId: input.threadId,
                      turnId,
                      itemId: item.id,
                      payload: { itemType: "assistant_message", status: "inProgress" },
                    });
                  }
                  const delta = stringField(event, "delta");
                  if (delta) {
                    yield* publish({
                      type: "content.delta",
                      ...(yield* makeEventStamp()),
                      provider: runtimeProvider,
                      providerInstanceId: boundInstanceId,
                      threadId: input.threadId,
                      turnId,
                      itemId: item.id,
                      payload: { streamKind: "assistant_text", delta },
                    });
                  }
                  return;
                }
                case "TEXT_MESSAGE_END": {
                  const sourceId = stringField(event, "messageId") ?? `assistant-${runId}`;
                  const item = items.get(sourceId);
                  if (!item) return;
                  items.delete(sourceId);
                  yield* publish({
                    type: "item.completed",
                    ...(yield* makeEventStamp()),
                    provider: runtimeProvider,
                    providerInstanceId: boundInstanceId,
                    threadId: input.threadId,
                    turnId,
                    itemId: item.id,
                    payload: { itemType: "assistant_message", status: "completed" },
                  });
                  return;
                }
                case "TOOL_CALL_START": {
                  const sourceId = stringField(event, "toolCallId");
                  if (!sourceId || items.has(sourceId)) return;
                  const title =
                    stringField(event, "toolCallName") ?? stringField(event, "toolName") ?? "Tool";
                  const itemId = RuntimeItemId.make(sourceId);
                  items.set(sourceId, { id: itemId, type: "mcp_tool_call", title });
                  yield* publish({
                    type: "item.started",
                    ...(yield* makeEventStamp()),
                    provider: runtimeProvider,
                    providerInstanceId: boundInstanceId,
                    threadId: input.threadId,
                    turnId,
                    itemId,
                    payload: { itemType: "mcp_tool_call", status: "inProgress", title },
                  });
                  return;
                }
                case "TOOL_CALL_END":
                case "TOOL_CALL_RESULT": {
                  const sourceId = stringField(event, "toolCallId");
                  const item = sourceId ? items.get(sourceId) : undefined;
                  if (!sourceId || !item) return;
                  items.delete(sourceId);
                  yield* publish({
                    type: "item.completed",
                    ...(yield* makeEventStamp()),
                    provider: runtimeProvider,
                    providerInstanceId: boundInstanceId,
                    threadId: input.threadId,
                    turnId,
                    itemId: item.id,
                    payload: {
                      itemType: "mcp_tool_call",
                      status: "completed",
                      ...(item.title ? { title: item.title } : {}),
                      data: event,
                    },
                  });
                  return;
                }
                case "RUN_FINISHED":
                  yield* completeOpenItems();
                  yield* completeTurn("completed");
                  return;
                case "RUN_ERROR":
                  yield* completeOpenItems();
                  yield* failTurn(stringField(event, "message") ?? "Compadre run failed.");
                  return;
              }
            });

          yield* Stream.runForEach(
            transport({
              endpoint: options.endpoint,
              apiKey: options.apiKey,
              threadId: input.threadId,
              runId,
              messageId,
              input: text,
              inputFiles,
              provider: selectedProvider,
              model: selectedModel,
            }),
            handleEvent,
          ).pipe(
            Effect.flatMap(() =>
              terminal
                ? Effect.void
                : failTurn("Compadre closed the stream before the run completed."),
            ),
            Effect.catch((cause) => failTurn(cause.message)),
            Effect.onInterrupt(() => completeTurn("cancelled")),
          );
        });

        const fiber = yield* worker.pipe(Effect.forkIn(adapterScope));
        context.activeFiber = fiber;
        yield* Fiber.await(fiber).pipe(
          Effect.tap(() => Effect.sync(() => (context.activeFiber = undefined))),
          Effect.forkIn(adapterScope),
        );
        return { threadId: input.threadId, turnId, resumeCursor: { runId } };
      });

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (context.activeFiber) {
          yield* cancelActiveRun(context).pipe(
            Effect.ensuring(Fiber.interrupt(context.activeFiber)),
          );
        }
      });

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        context.stopped = true;
        if (context.activeFiber) {
          yield* cancelActiveRun(context).pipe(
            Effect.ensuring(Fiber.interrupt(context.activeFiber)),
          );
        }
        sessions.delete(threadId);
        yield* publish({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: runtimeProvider,
          providerInstanceId: boundInstanceId,
          threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const unsupported = (operation: string) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: runtimeProvider,
          operation,
          issue: "This operation is not supported by the Compadre provider experiment.",
        }),
      );

    const respondToRequest = (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _decision: ProviderApprovalDecision,
    ) => unsupported("respondToRequest");
    const respondToUserInput = (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _answers: ProviderUserInputAnswers,
    ) => unsupported("respondToUserInput");
    const readThread = (threadId: ThreadId) =>
      Effect.map(
        requireSession(threadId),
        (context): ProviderThreadSnapshot => ({
          threadId,
          turns: context.turns.map((turn) => ({ ...turn, items: [...turn.items] })),
        }),
      );
    const rollbackThread = (threadId: ThreadId, numTurns: number) =>
      Effect.map(requireSession(threadId), (context): ProviderThreadSnapshot => {
        context.turns.splice(Math.max(0, context.turns.length - numTurns), numTurns);
        return {
          threadId,
          turns: context.turns.map((turn) => ({ ...turn, items: [...turn.items] })),
        };
      });
    const stopAll = () =>
      Effect.forEach(Array.from(sessions.keys()), stopSession, { discard: true }).pipe(
        Effect.catch(() => Effect.void),
      );

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.andThen(Scope.close(adapterScope, Exit.void)),
        Effect.andThen(PubSub.shutdown(runtimeEvents)),
      ),
    );

    return {
      provider: runtimeProvider,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions: () =>
        Effect.sync(() => Array.from(sessions.values(), ({ session }) => session)),
      hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEvents),
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
