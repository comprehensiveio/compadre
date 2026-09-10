import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionSelection,
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
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  makeCompadreCancelTransport,
  makeCompadreSteerTransport,
  makeCompadreTransport,
  type CompadreCancelTransport,
  type CompadreSteerTransport,
  type CompadreTransport,
} from "./CompadreTransport.ts";

export interface CompadreAdapterOptions {
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider?: "claude-code" | "codex";
  /** Native provider identity presented to T3 orchestration. */
  readonly runtimeProvider: ProviderDriverKind;
  readonly transport?: CompadreTransport;
  readonly cancelTransport?: CompadreCancelTransport;
  readonly steerTransport?: CompadreSteerTransport;
  readonly attachmentsDir?: string;
  /** Base delay for durable stream reconnects; defaults to 250ms. */
  readonly reconnectBaseDelayMs?: number;
}

interface ActiveCompadreRun {
  readonly runId: string;
  readonly fiber: Fiber.Fiber<void, ProviderAdapterRequestError>;
}

interface CompadreSessionContext {
  session: ProviderSession;
  modelOptions: ReadonlyArray<ProviderOptionSelection>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeRun: ActiveCompadreRun | undefined;
  stopped: boolean;
}

function stringField(event: Readonly<Record<string, unknown>>, field: string): string | undefined {
  const value = event[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function makeCompadreAdapter(options: CompadreAdapterOptions) {
  return Effect.gen(function* () {
    const runtimeProvider = options.runtimeProvider;
    const boundInstanceId = options.instanceId;
    const crypto = yield* Crypto.Crypto;
    const adapterScope = yield* Scope.make("sequential");
    const httpClient = yield* HttpClient.HttpClient;
    const fileSystem = yield* FileSystem.FileSystem;
    const transport =
      options.transport ??
      makeCompadreTransport(httpClient, runtimeProvider, options.reconnectBaseDelayMs ?? 250);
    const steerTransport =
      options.steerTransport ?? makeCompadreSteerTransport(httpClient, runtimeProvider);
    const cancelTransport =
      options.cancelTransport ?? makeCompadreCancelTransport(httpClient, runtimeProvider);
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
        context.activeRun = undefined;
      });

    const cancelActiveRun = (context: CompadreSessionContext) =>
      context.activeRun
        ? cancelTransport({
            endpoint: options.endpoint,
            apiKey: options.apiKey,
            runId: context.activeRun.runId,
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
        if (existing?.activeRun) yield* Fiber.interrupt(existing.activeRun.fiber);

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
          modelOptions:
            input.modelSelection?.instanceId === boundInstanceId
              ? (input.modelSelection.options ?? [])
              : [],
          turns: [],
          activeRun: undefined,
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
          (attachments.length > 0 ? "Please inspect the attached file(s)." : undefined);
        if (!text) {
          return yield* new ProviderAdapterValidationError({
            provider: runtimeProvider,
            operation: "sendTurn",
            issue: "A non-empty text input is required for the Compadre provider transport.",
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
        const selectedModel =
          input.modelSelection?.instanceId === boundInstanceId
            ? input.modelSelection.model
            : context.session.model;
        const selectedModelOptions =
          input.modelSelection?.instanceId === boundInstanceId
            ? (input.modelSelection.options ?? [])
            : context.modelOptions;
        const selectedProvider = options.provider;

        const previousRun = context.activeRun;
        const steeringTurnId =
          previousRun && context.session.status === "running"
            ? context.session.activeTurnId
            : undefined;

        const turnId = steeringTurnId ?? TurnId.make(yield* randomId);
        const runId = yield* randomId;
        const messageId = yield* randomId;
        if (!steeringTurnId) context.turns.push({ id: turnId, items: [] });
        context.modelOptions = selectedModelOptions;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          ...(selectedModel ? { model: selectedModel } : {}),
          updatedAt: yield* nowIso,
        };

        const transportInput = {
          endpoint: options.endpoint,
          apiKey: options.apiKey,
          threadId: input.threadId,
          runId,
          messageId,
          input: text,
          runtimeMode: context.session.runtimeMode,
          interactionMode: input.interactionMode ?? "default",
          inputFiles,
          provider: selectedProvider,
          model: selectedModel,
          modelOptions: selectedModelOptions,
          attribution: input.attribution,
        };

        if (steeringTurnId && previousRun) {
          if (inputFiles.length > 0) {
            return yield* new ProviderAdapterValidationError({
              provider: runtimeProvider,
              operation: "sendTurn",
              issue: "Send attachments after the active turn stops.",
            });
          }
          yield* steerTransport({
            endpoint: options.endpoint,
            apiKey: options.apiKey,
            runId: previousRun.runId,
            id: messageId,
            text: input.attribution
              ? `Current ${input.attribution.origin} request from ${input.attribution.displayName}:\n${text}`
              : text,
          });
          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: {
              runId: previousRun.runId,
            },
          };
        }

        let activeRun: ActiveCompadreRun | undefined;

        const worker = Effect.gen(function* () {
          let terminal = false;
          const finish = () =>
            Effect.gen(function* () {
              if (terminal) return;
              terminal = true;
              yield* setSessionReady(context);
            });
          const fail = (message: string) =>
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
              yield* finish();
            });
          // The controller stream reports run lifecycle only. Native worker
          // events own messages, tools, questions, background work and completion.
          yield* Stream.runForEach(transport(transportInput), (event) => {
            if (event.type === "RUN_FINISHED") return finish();
            if (event.type === "RUN_ERROR")
              return stringField(event, "code") === "NATIVE_T3_RUN_CANCELLED"
                ? finish()
                : fail(stringField(event, "message") ?? "Native worker run failed.");
            return Effect.void;
          }).pipe(
            Effect.flatMap(() =>
              terminal ? Effect.void : fail("Compadre closed the stream before the run completed."),
            ),
            Effect.catch((cause) => fail(cause.message)),
            Effect.onInterrupt(finish),
          );
        });

        const fiber = yield* worker.pipe(Effect.forkIn(adapterScope));
        activeRun = { runId, fiber };
        context.activeRun = activeRun;
        yield* Fiber.await(fiber).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (context.activeRun === activeRun) context.activeRun = undefined;
            }),
          ),
          Effect.forkIn(adapterScope),
        );
        return { threadId: input.threadId, turnId, resumeCursor: { runId } };
      });

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
      threadId,
      turnId,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (turnId && context.session.activeTurnId !== turnId) return;
        if (context.activeRun) {
          yield* cancelActiveRun(context).pipe(
            Effect.ensuring(Fiber.interrupt(context.activeRun.fiber)),
          );
        }
      });

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        context.stopped = true;
        if (context.activeRun) {
          yield* cancelActiveRun(context).pipe(
            Effect.ensuring(Fiber.interrupt(context.activeRun.fiber)),
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
          issue: "This operation must use the native thread binding.",
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
    // Central shutdown detaches its local watchers. The controller and worker
    // keep owning execution and journal delivery across a web restart.
    const stopAll = () =>
      Effect.forEach(
        Array.from(sessions.values()),
        (context) => (context.activeRun ? Fiber.interrupt(context.activeRun.fiber) : Effect.void),
        { discard: true },
      ).pipe(Effect.tap(() => Effect.sync(() => sessions.clear())));

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
