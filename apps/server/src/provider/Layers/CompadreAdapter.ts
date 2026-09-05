import * as Schema from "effect/Schema";
import { SavedWorkspaceReview } from "@t3tools/contracts";
import { CompadreAttachmentStore } from "../../assets/CompadreAttachmentStore.ts";
import {
  ApprovalRequestId,
  type ChatAttachment,
  EventId,
  isProviderSendTurnSupportedImageMimeType,
  isToolLifecycleItemType,
  PROVIDER_OUTPUT_ARTIFACT_MAX_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionSelection,
  RuntimeItemId,
  type ThreadTokenUsageSnapshot,
  type ToolLifecycleItemType,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
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
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { resolveAttachmentPath, toSafeThreadAttachmentSegment } from "../../attachmentStore.ts";
import {
  makeCompadreCancelTransport,
  makeCompadreSteerTransport,
  makeCompadreTransport,
  type CompadreCancelTransport,
  type CompadreSteerTransport,
  type CompadreStreamEvent,
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

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parsedJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function eventData(event: CompadreStreamEvent): unknown {
  if (event.data !== undefined) return event.data;
  const content = record(parsedJson(stringField(event, "content")));
  if (content && "data" in content) return content.data;
  return parsedJson(stringField(event, "args") ?? stringField(event, "delta"));
}

function eventDetail(event: CompadreStreamEvent): string | undefined {
  const direct = stringField(event, "detail");
  if (direct) return direct;
  const content = record(parsedJson(stringField(event, "content")));
  return content && typeof content.detail === "string" && content.detail.length > 0
    ? content.detail
    : undefined;
}

function toolItemType(event: CompadreStreamEvent): ToolLifecycleItemType {
  const itemType = stringField(event, "itemType");
  return itemType && isToolLifecycleItemType(itemType) ? itemType : "dynamic_tool_call";
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function usageSnapshot(event: CompadreStreamEvent): ThreadTokenUsageSnapshot | undefined {
  const source = record(event.usage);
  const usedTokens = nonNegativeInteger(source?.usedTokens);
  if (usedTokens === undefined) return undefined;
  const optionalNumber = (key: string) => {
    const value = nonNegativeInteger(source?.[key]);
    return value === undefined ? {} : { [key]: value };
  };
  const usageProvider = source?.usageProvider;
  const model = stringField(source ?? {}, "model");
  return {
    usedTokens,
    ...optionalNumber("totalProcessedTokens"),
    ...optionalNumber("maxTokens"),
    ...optionalNumber("inputTokens"),
    ...optionalNumber("cachedInputTokens"),
    ...optionalNumber("outputTokens"),
    ...optionalNumber("reasoningOutputTokens"),
    ...optionalNumber("lastUsedTokens"),
    ...optionalNumber("lastInputTokens"),
    ...optionalNumber("lastCachedInputTokens"),
    ...optionalNumber("lastOutputTokens"),
    ...optionalNumber("lastReasoningOutputTokens"),
    ...optionalNumber("toolUses"),
    ...optionalNumber("durationMs"),
    ...(usageProvider === "claude" || usageProvider === "codex"
      ? { usageProvider: usageProvider as "claude" | "codex" }
      : {}),
    ...(model ? { model } : {}),
  };
}

const decodeSavedReview = Schema.decodeUnknownEffect(SavedWorkspaceReview);

function artifactAttachmentId(threadId: ThreadId, digest: string): string | undefined {
  const segment = toSafeThreadAttachmentSegment(threadId);
  if (!segment || !/^[a-f0-9]{64}$/iu.test(digest)) return undefined;
  return `${segment}-${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function decodeOutputArtifact(
  event: CompadreStreamEvent,
  threadId: ThreadId,
):
  | {
      artifactId: string;
      attachment: ChatAttachment;
    }
  | undefined {
  const artifact = record(event.artifact);
  if (!artifact || artifact.storage !== "hosted-object") return undefined;
  const digest = stringField(artifact, "artifactId");
  const mimeType = stringField(artifact, "mimetype")?.toLowerCase();
  const sizeBytes = nonNegativeInteger(artifact.sizeBytes);
  const rawName = stringField(artifact, "name") ?? stringField(artifact, "path");
  const id = digest ? artifactAttachmentId(threadId, digest) : undefined;
  if (
    !digest ||
    !id ||
    !mimeType ||
    sizeBytes === undefined ||
    sizeBytes > PROVIDER_OUTPUT_ARTIFACT_MAX_BYTES ||
    !rawName
  )
    return undefined;
  const name = rawName.split(/[\\/]/u).at(-1)?.trim().slice(0, 255);
  if (!name) return undefined;
  const attachment: ChatAttachment =
    isProviderSendTurnSupportedImageMimeType(mimeType) &&
    sizeBytes <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
      ? { type: "image", id, name, mimeType, sizeBytes }
      : { type: "file", id, name, mimeType, sizeBytes };
  return { artifactId: digest, attachment };
}

function outputArtifactEndpoint(endpoint: string, runId: string, artifactId: string): string {
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/\/chat\/?$/u, "/artifacts");
  url.search = "";
  url.searchParams.set("runId", runId);
  url.searchParams.set("artifactId", artifactId);
  return url.toString();
}

export function makeCompadreAdapter(options: CompadreAdapterOptions) {
  return Effect.gen(function* () {
    const runtimeProvider = options.runtimeProvider;
    const boundInstanceId = options.instanceId;
    const crypto = yield* Crypto.Crypto;
    const adapterScope = yield* Scope.make("sequential");
    const httpClient = yield* HttpClient.HttpClient;
    const fileSystem = yield* FileSystem.FileSystem;
    const attachmentObjects = yield* CompadreAttachmentStore;
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
        if (!steeringTurnId) {
          yield* publish({
            type: "turn.started",
            ...(yield* makeEventStamp()),
            provider: runtimeProvider,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            turnId,
            payload: context.session.model ? { model: context.session.model } : {},
          });
        }

        const transportInput = {
          endpoint: options.endpoint,
          apiKey: options.apiKey,
          threadId: input.threadId,
          runId,
          messageId,
          input: text,
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
          const steerResult = yield* steerTransport({
            endpoint: options.endpoint,
            apiKey: options.apiKey,
            runId: previousRun.runId,
            id: messageId,
            text: input.attribution
              ? `Current ${input.attribution.origin} request from ${input.attribution.displayName}:\n${text}`
              : text,
          });
          if (steerResult === "unsupported") {
            // During the independent controller/web rollout, retain the old
            // additive `/chat` steering request until every controller serves
            // the run-level endpoint.
            yield* Stream.runForEach(transport(transportInput), () => Effect.void).pipe(
              Effect.catch((cause) =>
                Effect.flatMap(makeEventStamp(), (stamp) =>
                  publish({
                    type: "runtime.error",
                    ...stamp,
                    provider: runtimeProvider,
                    providerInstanceId: boundInstanceId,
                    threadId: input.threadId,
                    turnId,
                    payload: {
                      message: cause.message,
                      class: "transport_error",
                    },
                  }),
                ),
              ),
              Effect.forkIn(adapterScope),
            );
          }
          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: {
              runId: steerResult === "accepted" ? previousRun.runId : runId,
            },
          };
        }

        let activeRun: ActiveCompadreRun | undefined;

        const worker = Effect.gen(function* () {
          const items = new Map<
            string,
            {
              readonly id: RuntimeItemId;
              type: "assistant_message" | ToolLifecycleItemType;
              title?: string;
              detail?: string;
              data?: unknown;
              argsText?: string;
            }
          >();
          const artifactAttachments = new Map<string, ChatAttachment>();
          let lastAssistantItemId: RuntimeItemId | undefined;
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
                      ...(item.detail ? { detail: item.detail } : {}),
                      ...(item.data !== undefined ? { data: item.data } : {}),
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
                  lastAssistantItemId = item.id;
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
                case "WORKSPACE_REVIEW": {
                  const savedReview = yield* decodeSavedReview(event.data).pipe(
                    Effect.mapError(
                      () =>
                        new ProviderAdapterRequestError({
                          provider: runtimeProvider,
                          method: "compadre/workspace-review",
                          detail: "Invalid saved workspace review metadata.",
                        }),
                    ),
                  );
                  yield* publish({
                    type: "turn.diff.updated",
                    ...(yield* makeEventStamp()),
                    provider: runtimeProvider,
                    providerInstanceId: boundInstanceId,
                    threadId: input.threadId,
                    turnId,
                    ...(lastAssistantItemId ? { itemId: lastAssistantItemId } : {}),
                    payload: { unifiedDiff: "", savedReview },
                  });
                  return;
                }
                case "WORKSPACE_REVIEW_UNAVAILABLE": {
                  yield* publish({
                    type: "runtime.warning",
                    ...(yield* makeEventStamp()),
                    provider: runtimeProvider,
                    providerInstanceId: boundInstanceId,
                    threadId: input.threadId,
                    turnId,
                    payload: {
                      message:
                        "Changes could not be saved for this turn. Previously saved diffs remain available.",
                    },
                  });
                  return;
                }
                case "OUTPUT_ARTIFACT": {
                  if (!options.attachmentsDir) {
                    return yield* new ProviderAdapterRequestError({
                      provider: runtimeProvider,
                      method: "compadre/output-artifact",
                      detail: "The Compadre attachment directory is not configured.",
                    });
                  }
                  const decoded = decodeOutputArtifact(event, input.threadId);
                  if (!decoded) return;
                  const attachmentPath = resolveAttachmentPath({
                    attachmentsDir: options.attachmentsDir,
                    attachment: decoded.attachment,
                  });
                  if (!attachmentPath) {
                    return yield* new ProviderAdapterRequestError({
                      provider: runtimeProvider,
                      method: "compadre/output-artifact",
                      detail: "Compadre emitted an unsafe output artifact identifier.",
                    });
                  }
                  let request = HttpClientRequest.get(
                    outputArtifactEndpoint(options.endpoint, runId, decoded.artifactId),
                  ).pipe(HttpClientRequest.setHeader("X-Compadre-T3-Protocol-Version", "2"));
                  if (options.apiKey) {
                    request = request.pipe(
                      HttpClientRequest.setHeader("authorization", `Bearer ${options.apiKey}`),
                    );
                  }
                  const bytes = yield* httpClient.execute(request).pipe(
                    Effect.flatMap(HttpClientResponse.filterStatusOk),
                    Effect.flatMap((response) => response.arrayBuffer),
                    Effect.map((buffer) => new Uint8Array(buffer)),
                    Effect.mapError(
                      (cause) =>
                        new ProviderAdapterRequestError({
                          provider: runtimeProvider,
                          method: "compadre/output-artifact",
                          detail: "Failed to download a Compadre output artifact.",
                          cause,
                        }),
                    ),
                  );
                  if (
                    bytes.byteLength !== decoded.attachment.sizeBytes ||
                    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !==
                      decoded.artifactId
                  ) {
                    return yield* new ProviderAdapterRequestError({
                      provider: runtimeProvider,
                      method: "compadre/output-artifact",
                      detail: "Compadre output artifact failed integrity validation.",
                    });
                  }
                  yield* fileSystem.makeDirectory(options.attachmentsDir, { recursive: true }).pipe(
                    Effect.andThen(fileSystem.writeFile(attachmentPath, bytes)),
                    Effect.mapError(
                      (cause) =>
                        new ProviderAdapterRequestError({
                          provider: runtimeProvider,
                          method: "compadre/output-artifact",
                          detail: "Failed to persist a Compadre output artifact.",
                          cause,
                        }),
                    ),
                  );
                  yield* attachmentObjects.persist(attachmentPath).pipe(
                    Effect.mapError(
                      (cause) =>
                        new ProviderAdapterRequestError({
                          provider: runtimeProvider,
                          method: "compadre/output-artifact",
                          detail: "Failed to store output object.",
                          cause,
                        }),
                    ),
                  );
                  artifactAttachments.set(decoded.attachment.id, decoded.attachment);
                  const itemId =
                    lastAssistantItemId ?? RuntimeItemId.make(`output-artifacts-${runId}`);
                  lastAssistantItemId = itemId;
                  yield* publish({
                    type: "item.completed",
                    ...(yield* makeEventStamp()),
                    provider: runtimeProvider,
                    providerInstanceId: boundInstanceId,
                    threadId: input.threadId,
                    turnId,
                    itemId,
                    payload: {
                      itemType: "assistant_message",
                      status: "completed",
                      attachments: [...artifactAttachments.values()],
                    },
                  });
                  return;
                }
                case "REASONING_CONTENT": {
                  const content = stringField(event, "content");
                  if (!content) return;
                  const itemId = RuntimeItemId.make(
                    stringField(event, "messageId") ?? `reasoning-${runId}`,
                  );
                  yield* publish({
                    type: "item.updated",
                    ...(yield* makeEventStamp()),
                    provider: runtimeProvider,
                    providerInstanceId: boundInstanceId,
                    threadId: input.threadId,
                    turnId,
                    itemId,
                    payload: {
                      itemType: "reasoning",
                      status: "inProgress",
                      title: "Thinking",
                      detail: content,
                    },
                  });
                  return;
                }
                case "TOOL_CALL_START": {
                  const sourceId = stringField(event, "toolCallId");
                  if (!sourceId || items.has(sourceId)) return;
                  const title =
                    stringField(event, "title") ??
                    stringField(event, "toolCallName") ??
                    stringField(event, "toolName") ??
                    "Tool";
                  const type = toolItemType(event);
                  const detail = eventDetail(event);
                  const data = eventData(event);
                  const itemId = RuntimeItemId.make(sourceId);
                  items.set(sourceId, {
                    id: itemId,
                    type,
                    title,
                    ...(detail ? { detail } : {}),
                    ...(data !== undefined ? { data } : {}),
                  });
                  yield* publish({
                    type: "item.started",
                    ...(yield* makeEventStamp()),
                    provider: runtimeProvider,
                    providerInstanceId: boundInstanceId,
                    threadId: input.threadId,
                    turnId,
                    itemId,
                    payload: {
                      itemType: type,
                      status: "inProgress",
                      title,
                      ...(detail ? { detail } : {}),
                      ...(data !== undefined ? { data } : {}),
                    },
                  });
                  return;
                }
                case "TOOL_CALL_ARGS": {
                  const sourceId = stringField(event, "toolCallId");
                  const item = sourceId ? items.get(sourceId) : undefined;
                  if (!item || item.type === "assistant_message" || item.data !== undefined) return;
                  const argsDelta = stringField(event, "delta") ?? stringField(event, "args");
                  if (argsDelta) item.argsText = `${item.argsText ?? ""}${argsDelta}`;
                  const data = eventData(event) ?? parsedJson(item.argsText);
                  if (data === undefined) return;
                  item.data = data;
                  yield* publish({
                    type: "item.updated",
                    ...(yield* makeEventStamp()),
                    provider: runtimeProvider,
                    providerInstanceId: boundInstanceId,
                    threadId: input.threadId,
                    turnId,
                    itemId: item.id,
                    payload: {
                      itemType: item.type,
                      status: "inProgress",
                      ...(item.title ? { title: item.title } : {}),
                      ...(item.detail ? { detail: item.detail } : {}),
                      data,
                    },
                  });
                  return;
                }
                case "TOOL_CALL_END":
                case "TOOL_CALL_RESULT": {
                  const sourceId = stringField(event, "toolCallId");
                  const item = sourceId ? items.get(sourceId) : undefined;
                  if (!sourceId || !item) return;
                  items.delete(sourceId);
                  const detail = eventDetail(event) ?? item.detail;
                  const data = eventData(event) ?? item.data;
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
                      ...(detail ? { detail } : {}),
                      ...(data !== undefined ? { data } : {}),
                    },
                  });
                  return;
                }
                case "THREAD_TOKEN_USAGE_UPDATED": {
                  const usage = usageSnapshot(event);
                  if (!usage) return;
                  yield* publish({
                    type: "thread.token-usage.updated",
                    ...(yield* makeEventStamp()),
                    provider: runtimeProvider,
                    providerInstanceId: boundInstanceId,
                    threadId: input.threadId,
                    turnId,
                    payload: { usage },
                  });
                  return;
                }
                case "RUN_FINISHED":
                  yield* completeOpenItems();
                  yield* completeTurn("completed");
                  return;
                case "RUN_ERROR":
                  yield* completeOpenItems();
                  if (stringField(event, "code") === "NATIVE_T3_RUN_CANCELLED") {
                    yield* completeTurn("cancelled");
                    return;
                  }
                  yield* failTurn(stringField(event, "message") ?? "Compadre run failed.");
                  return;
              }
            });

          yield* Stream.runForEach(transport(transportInput), handleEvent).pipe(
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
