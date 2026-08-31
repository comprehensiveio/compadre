import { EventType, type StreamChunk } from "./agui-protocol.js";
import {
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  trace as otelTrace,
  type Context,
  type Tracer,
} from "@opentelemetry/api";
import type {
  T3Client,
  T3MessageAttribution,
  T3InputFile,
  T3ModelSelection,
  T3ThreadSnapshot,
  T3TurnDispatch,
} from "./client.js";
import { preTurnStartFailure } from "./client.js";
import type { T3GatewayTurn } from "./gateway.js";
import type { AgentProfile } from "../tanstack/protocol.js";
import {
  CENTRAL_T3_TIMEOUT_MS,
  centralT3AbsoluteTimeoutMs,
  centralT3ApiMessageId,
  centralT3ThreadId,
  runCentralT3Conversation,
  type CentralT3ConversationClient,
  type CentralT3ConversationPrepared,
} from "./central-conversation.js";

export interface NativeT3AguiGateway {
  send(input: {
    canonicalThreadId: string;
    title: string;
    text: string;
    modelSelection: T3ModelSelection;
    inputFiles?: ReadonlyArray<T3InputFile>;
    blockedSlackDestination?: {
      channelId: string;
      threadTs: string;
    };
    signal?: AbortSignal;
  }): Promise<T3GatewayTurn>;
  waitForTerminal(input: {
    turn: T3GatewayTurn;
    timeoutMs?: number;
    absoluteTimeoutMs?: number;
    signal?: AbortSignal;
    onSnapshot?(snapshot: T3ThreadSnapshot): void | Promise<void>;
  }): Promise<T3ThreadSnapshot>;
  snapshot?(input: {
    canonicalThreadId: string;
    providerInstanceId: string;
    signal?: AbortSignal;
  }): Promise<{
    binding: T3GatewayTurn["binding"];
    snapshot: T3ThreadSnapshot;
    source: "central" | "worker";
  } | null>;
  collectOutputArtifacts?(
    turn: T3GatewayTurn,
    publish: (artifact: import("./output-artifacts.js").T3OutputArtifact) => Promise<void>,
  ): Promise<{ published: Array<{ path: string; digest: string }>; failures: string[] }>;
}

export interface NativeT3AguiStreamInput {
  gateway: NativeT3AguiGateway;
  canonicalThreadId: string;
  runId: string;
  title: string;
  text: string;
  modelSelection: T3ModelSelection;
  inputFiles?: ReadonlyArray<T3InputFile>;
  blockedSlackDestination?: {
    channelId: string;
    threadTs: string;
  };
  signal?: AbortSignal;
  onTurn?(turn: T3GatewayTurn): void | Promise<void>;
  onTerminal?(): void | Promise<void>;
  outputArtifactEvents?(turn: T3GatewayTurn): Promise<StreamChunk[]>;
}

export interface NativeT3AguiRecoveryStreamInput {
  gateway: NativeT3AguiGateway;
  canonicalThreadId: string;
  runId: string;
  startedAt: number;
  signal?: AbortSignal;
  onTurn?(turn: T3GatewayTurn): void | Promise<void>;
  onTerminal?(): void | Promise<void>;
}

export interface CentralT3AguiStreamInput {
  client: CentralT3ConversationClient;
  canonicalThreadId: string;
  runId: string;
  title: string;
  text: string;
  displayText?: string;
  attribution?: T3MessageAttribution;
  profile?: AgentProfile;
  modelSelection?: T3ModelSelection;
  signal?: AbortSignal;
  onPrepared?(prepared: CentralT3ConversationPrepared): void | Promise<void>;
  onDispatched?(
    prepared: CentralT3ConversationPrepared,
    dispatch: T3TurnDispatch,
  ): void | Promise<void>;
}

export interface CentralT3AguiRecoveryStreamInput {
  client: CentralT3ConversationClient & Pick<T3Client, "threadSnapshot">;
  canonicalThreadId: string;
  runId: string;
  startedAt: number;
  signal?: AbortSignal;
}

export interface NativeT3AguiTraceOptions {
  canonicalThreadId: string;
  runId: string;
  provider: "claude-code" | "codex";
  model?: string;
  tracer?: Tracer;
  parentContext?: Context;
}

/** Keep the provider request span active until its streamed turn is terminal. */
export function traceNativeT3AguiStream(
  stream: AsyncIterable<StreamChunk>,
  options: NativeT3AguiTraceOptions,
): AsyncIterable<StreamChunk> {
  const tracer = options.tracer ?? otelTrace.getTracer("compadre.t3.provider");
  const parentContext = options.parentContext ?? otelContext.active();
  const span = tracer.startSpan(
    "compadre.t3.provider.turn",
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "agui.thread_id": options.canonicalThreadId,
        "agui.run_id": options.runId,
        "agent.provider": options.provider,
        "gen_ai.operation.name": "invoke_agent",
        // The worker exports the logical Agent Observability trace directly so
        // this controller span remains an APM-only distributed-service span.
        "dd_llmobs_enabled": false,
        "gen_ai.conversation.id": options.canonicalThreadId,
        "gen_ai.provider.name":
          options.provider === "codex" ? "openai" : "anthropic",
        ...(options.model ? { "gen_ai.request.model": options.model } : {}),
      },
    },
    parentContext,
  );
  const spanContext = otelTrace.setSpan(parentContext, span);

  return {
    async *[Symbol.asyncIterator]() {
      const iterator = otelContext.with(spanContext, () =>
        stream[Symbol.asyncIterator](),
      );
      let returned = false;
      try {
        while (true) {
          const next = await otelContext.with(spanContext, () =>
            iterator.next(),
          );
          if (next.done) break;
          if (next.value.type === EventType.RUN_ERROR) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: next.value.message || "Native T3 provider failed",
            });
          }
          yield next.value;
        }
      } catch (error) {
        span.recordException(error instanceof Error ? error : String(error));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        if (!returned && iterator.return) {
          returned = true;
          await otelContext.with(spanContext, () => iterator.return!());
        }
        span.end();
      }
    },
  };
}

interface T3Activity {
  id: string;
  kind: string;
  turnId?: string;
  summary?: string;
  createdAt?: string;
  payload?: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function activities(snapshot: T3ThreadSnapshot): T3Activity[] {
  const raw = snapshot.thread.activities;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    const item = record(value);
    const id = stringValue(item?.id);
    const kind = stringValue(item?.kind);
    if (!item || !id || !kind) return [];
    return [{
      id,
      kind,
      turnId: stringValue(item.turnId),
      summary: stringValue(item.summary),
      createdAt: stringValue(item.createdAt),
      payload: record(item.payload),
    }];
  });
}

function timestamp(value?: string): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function projectedUsage(
  activity: T3Activity,
  snapshot: T3ThreadSnapshot,
): Record<string, unknown> | undefined {
  if (activity.kind !== "context-window.updated") return undefined;
  const payload = activity.payload ?? {};
  const usedTokens = nonNegativeInteger(payload.usedTokens);
  if (usedTokens === undefined) return undefined;
  const provider = snapshot.thread.modelSelection.instanceId === "codex" ? "codex" : "claude";
  return {
    ...payload,
    usedTokens,
    usageProvider: provider,
    model: snapshot.thread.modelSelection.model,
  };
}

function normalizedActivitySummary(activity: T3Activity): string | undefined {
  const summary = activity.summary?.trim();
  if (!summary) return undefined;
  return summary.replace(/\s+(?:started|complete|completed)\s*$/iu, "").trim();
}

function toolNameForActivity(activity: T3Activity): string {
  const payload = activity.payload ?? {};
  const data = record(payload.data);
  const item = record(data?.item);
  if (payload.itemType === "mcp_tool_call") {
    const server = stringValue(item?.server);
    const tool = stringValue(item?.tool);
    if (server && tool) return `${server} · ${tool}`;
    if (tool) return tool;
    const providerToolName = stringValue(data?.toolName);
    if (providerToolName) return providerToolName;
  }
  const providerToolName = stringValue(data?.toolName);
  if (providerToolName) return providerToolName;
  const detail = stringValue(payload.detail);
  const detailToolName = detail?.match(/^([\p{L}\p{N}_-]+)\s*:/u)?.[1];
  if (detailToolName) return detailToolName;
  return (
    normalizedActivitySummary(activity) ??
    stringValue(payload.itemType)?.replaceAll("_", " ") ??
    "Tool"
  );
}

interface ProjectedAssistantMessage {
  text: string;
  ended: boolean;
}

interface ProjectedTool {
  itemType?: string;
  title: string;
  detail?: string;
  data?: unknown;
}

/**
 * Incremental projection from a native worker T3 snapshot into the provider
 * event stream consumed by the central T3 environment. The worker owns the
 * provider process; this projection deliberately emits only events that the
 * central orchestration log needs to render the thread.
 */
export class NativeT3SnapshotProjector {
  private turnId: string | undefined;
  private terminal = false;
  private readonly seenActivities = new Set<string>();
  private readonly tools = new Map<string, ProjectedTool>();
  private readonly assistantMessages = new Map<string, ProjectedAssistantMessage>();

  constructor(
    private readonly runId: string,
    private readonly canonicalThreadId: string,
    private readonly requestedMessageId: string,
  ) {}

  project(snapshot: T3ThreadSnapshot): StreamChunk[] {
    if (this.terminal) return [];
    const requestedMessage = snapshot.thread.messages.find(
      (message) => message.id === this.requestedMessageId && message.role === "user",
    );
    if (!requestedMessage) return [];
    this.turnId = requestedMessage.turnId ?? this.turnId;
    if (!this.turnId) {
      // Native T3 providers currently leave the user message unbound while
      // assigning the actual turn id to `latestTurn` and assistant messages.
      // A message sent while that turn is running is a native provider steer:
      // it intentionally lands after the turn's original requestedAt. Adopt
      // the active turn immediately so replacement output can keep streaming,
      // or a terminal turn only when it completed after the steering message.
      // A message appended after an older turn completed must not replay that
      // stale turn.
      const latestTurn = snapshot.thread.latestTurn;
      const messageCreatedAt = Date.parse(requestedMessage.createdAt);
      const turnRequestedAt = Date.parse(latestTurn?.requestedAt ?? "");
      const turnCompletedAt = Date.parse(latestTurn?.completedAt ?? "");
      const isNormalTurn =
        Number.isFinite(turnRequestedAt) &&
        turnRequestedAt >= messageCreatedAt;
      const isActiveSteer =
        latestTurn?.state === "running" &&
        Number.isFinite(turnRequestedAt) &&
        turnRequestedAt < messageCreatedAt;
      const isCompletedSteer =
        Number.isFinite(turnCompletedAt) &&
        turnCompletedAt >= messageCreatedAt;
      if (
        latestTurn?.turnId &&
        Number.isFinite(messageCreatedAt) &&
        (isNormalTurn || isActiveSteer || isCompletedSteer)
      ) {
        this.turnId = latestTurn.turnId;
      }
    }
    if (!this.turnId) {
      const startFailure = preTurnStartFailure(
        snapshot,
        this.requestedMessageId,
      );
      if (!startFailure) return [];
      this.terminal = true;
      return [{
        type: EventType.RUN_ERROR,
        runId: this.runId,
        message: startFailure.message,
        timestamp: timestamp(startFailure.createdAt),
      }];
    }

    const chunks: StreamChunk[] = [];
    const requestedAt = timestamp(requestedMessage.createdAt);
    const turnRequestedAt = timestamp(snapshot.thread.latestTurn?.requestedAt);
    const isSteer = turnRequestedAt < requestedAt;
    for (const activity of activities(snapshot)) {
      if (this.seenActivities.has(activity.id)) continue;
      if (isSteer && timestamp(activity.createdAt) < requestedAt) continue;
      const unboundCurrentTurnUsage =
        activity.kind === "context-window.updated" &&
        activity.turnId === undefined &&
        timestamp(activity.createdAt) >= requestedAt;
      if (activity.turnId !== this.turnId && !unboundCurrentTurnUsage) continue;
      this.seenActivities.add(activity.id);
      const usage = projectedUsage(activity, snapshot);
      if (usage) {
        chunks.push({
          type: EventType.THREAD_TOKEN_USAGE_UPDATED,
          usage,
          timestamp: timestamp(activity.createdAt),
        });
        continue;
      }
      if (!activity.kind.startsWith("tool.")) continue;
      const payload = activity.payload ?? {};
      const toolCallId = stringValue(payload.toolCallId) ?? activity.id;
      const toolName = toolNameForActivity(activity);
      const existingTool = this.tools.get(toolCallId);
      const itemType = stringValue(payload.itemType) ?? existingTool?.itemType;
      const title = normalizedActivitySummary(activity) ?? existingTool?.title ?? toolName;
      const detail = stringValue(payload.detail) ?? existingTool?.detail;
      const data = payload.data !== undefined ? payload.data : existingTool?.data;
      if (!existingTool) {
        this.tools.set(toolCallId, {
          ...(itemType ? { itemType } : {}),
          title,
          ...(detail ? { detail } : {}),
          ...(data !== undefined ? { data } : {}),
        });
        chunks.push({
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName: toolName,
          toolName,
          ...(itemType ? { itemType } : {}),
          title,
          ...(detail ? { detail } : {}),
          ...(data !== undefined ? { data } : {}),
          ...(stringValue(payload.status) ? { status: stringValue(payload.status) } : {}),
          timestamp: timestamp(activity.createdAt),
        });
        chunks.push({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: json(data),
          args: json(data),
          ...(itemType ? { itemType } : {}),
          ...(data !== undefined ? { data } : {}),
          timestamp: timestamp(activity.createdAt),
        });
      }
      if (activity.kind === "tool.completed") {
        chunks.push({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId,
          messageId: activity.id,
          ...(itemType ? { itemType } : {}),
          title,
          ...(detail ? { detail } : {}),
          ...(data !== undefined ? { data } : {}),
          ...(stringValue(payload.status) ? { status: stringValue(payload.status) } : {}),
          content: json({
            summary: activity.summary,
            detail: payload.detail,
            data: payload.data,
            status: payload.status,
          }),
          timestamp: timestamp(activity.createdAt),
        });
      }
    }

    const assistants = snapshot.thread.messages.filter(
      (message) =>
        message.role === "assistant" &&
        message.turnId === this.turnId &&
        (!isSteer || timestamp(message.createdAt) >= requestedAt),
    );
    for (const assistant of assistants) {
      let projected = this.assistantMessages.get(assistant.id);
      if (!projected) {
        projected = { text: "", ended: false };
        this.assistantMessages.set(assistant.id, projected);
        chunks.push({
          type: EventType.TEXT_MESSAGE_START,
          messageId: assistant.id,
          role: "assistant",
          timestamp: timestamp(assistant.createdAt),
        });
      }
      const delta = assistant.text.startsWith(projected.text)
        ? assistant.text.slice(projected.text.length)
        : assistant.text;
      if (delta) {
        projected.text = assistant.text;
        chunks.push({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: assistant.id,
          delta,
          content: assistant.text,
          timestamp: timestamp(assistant.updatedAt),
        });
      }
      if (!assistant.streaming && !projected.ended) {
        projected.ended = true;
        chunks.push({
          type: EventType.TEXT_MESSAGE_END,
          messageId: assistant.id,
          timestamp: timestamp(assistant.updatedAt),
        });
      }
    }

    const latestTurn = snapshot.thread.latestTurn;
    if (latestTurn?.turnId !== this.turnId || latestTurn.state === "running") {
      return chunks;
    }
    for (const [messageId, projected] of this.assistantMessages) {
      if (!projected.ended) {
        projected.ended = true;
        chunks.push({
          type: EventType.TEXT_MESSAGE_END,
          messageId,
          timestamp: timestamp(latestTurn.completedAt ?? undefined),
        });
      }
    }
    this.terminal = true;
    if (latestTurn.state === "completed") {
      chunks.push({
        type: EventType.RUN_FINISHED,
        runId: this.runId,
        threadId: this.canonicalThreadId,
        finishReason: "stop",
        timestamp: timestamp(latestTurn.completedAt ?? undefined),
      });
    } else {
      chunks.push({
        type: EventType.RUN_ERROR,
        runId: this.runId,
        message:
          snapshot.thread.session?.lastError ??
          `Native T3 turn ${latestTurn.state}.`,
        timestamp: timestamp(latestTurn.completedAt ?? undefined),
      });
    }
    return chunks;
  }
}

export async function* createNativeT3AguiStream(
  input: NativeT3AguiStreamInput,
): AsyncIterable<StreamChunk> {
  yield {
    type: EventType.RUN_STARTED,
    runId: input.runId,
    threadId: input.canonicalThreadId,
    timestamp: Date.now(),
  };
  try {
    const turn = await input.gateway.send({
      canonicalThreadId: input.canonicalThreadId,
      title: input.title,
      text: input.text,
      modelSelection: input.modelSelection,
      inputFiles: input.inputFiles,
      blockedSlackDestination: input.blockedSlackDestination,
      signal: input.signal,
    });
    await input.onTurn?.(turn);
    const projector = new NativeT3SnapshotProjector(
      input.runId,
      input.canonicalThreadId,
      turn.dispatch.messageId,
    );
    const pending: StreamChunk[] = [];
    let wake: (() => void) | undefined;
    let completed = false;
    let failure: unknown;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    const waiter = input.gateway.waitForTerminal({
      turn,
      signal: input.signal,
      onSnapshot(snapshot) {
        pending.push(...projector.project(snapshot));
        notify();
      },
    }).then(
      (snapshot) => {
        pending.push(...projector.project(snapshot));
        completed = true;
        notify();
      },
      (error) => {
        failure = error;
        completed = true;
        notify();
      },
    );

    while (!completed || pending.length > 0) {
      if (pending.length === 0) {
        if (completed) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      const chunk = pending.shift()!;
      if (
        chunk.type === EventType.RUN_FINISHED &&
        input.outputArtifactEvents
      ) {
        for (const artifactEvent of await input.outputArtifactEvents(turn)) {
          yield artifactEvent;
        }
      }
      yield chunk;
    }
    await waiter;
    if (failure) throw failure;
  } catch (error) {
    yield {
      type: EventType.RUN_ERROR,
      runId: input.runId,
      message: error instanceof Error ? error.message : "Native T3 worker failed.",
      timestamp: Date.now(),
    };
  } finally {
    await input.onTerminal?.();
  }
}

function recoveryTurn(input: {
  canonicalThreadId: string;
  runId: string;
  startedAt: number;
  binding: T3GatewayTurn["binding"];
  snapshot: T3ThreadSnapshot;
}): T3GatewayTurn {
  const latestTurn = input.snapshot.thread.latestTurn;
  if (!latestTurn) {
    throw new Error(`Native T3 run ${input.runId} has no worker turn to resume`);
  }
  const requestedAt = Date.parse(latestTurn.requestedAt);
  const requestedMessage = [...input.snapshot.thread.messages]
    .reverse()
    .find((message) => {
      if (message.role !== "user") return false;
      const createdAt = Date.parse(message.createdAt);
      return (
        Number.isFinite(createdAt) &&
        Number.isFinite(requestedAt) &&
        createdAt <= requestedAt + 1_000 &&
        createdAt >= input.startedAt - 5_000
      );
    });
  if (!requestedMessage) {
    throw new Error(
      `Native T3 run ${input.runId} could not identify its requested worker message`,
    );
  }
  return {
    binding: input.binding,
    dispatch: {
      sequence: input.snapshot.snapshotSequence,
      commandId: `recovery:${input.runId}`,
      messageId: requestedMessage.id,
      threadId: input.binding.t3ThreadId,
      createdAt: requestedMessage.createdAt,
    },
  };
}

/**
 * Re-project an already-dispatched native T3 turn after the controller that
 * originally tailed it disappeared. The worker snapshot contains the full
 * narration/tool transcript, so replay starts from that durable source and
 * dispatches no new provider request.
 */
export async function* createNativeT3AguiRecoveryStream(
  input: NativeT3AguiRecoveryStreamInput,
): AsyncIterable<StreamChunk> {
  try {
    if (!input.gateway.snapshot) {
      throw new Error("Native T3 gateway cannot recover worker snapshots");
    }
    const resolved = await input.gateway.snapshot({
      canonicalThreadId: input.canonicalThreadId,
      providerInstanceId: "",
      signal: input.signal,
    });
    if (!resolved) {
      throw new Error(`Native T3 thread ${input.canonicalThreadId} is unavailable`);
    }
    const turn = recoveryTurn({
      canonicalThreadId: input.canonicalThreadId,
      runId: input.runId,
      startedAt: input.startedAt,
      binding: resolved.binding,
      snapshot: resolved.snapshot,
    });
    await input.onTurn?.(turn);
    const projector = new NativeT3SnapshotProjector(
      input.runId,
      input.canonicalThreadId,
      turn.dispatch.messageId,
    );
    for (const chunk of projector.project(resolved.snapshot)) yield chunk;
    if (resolved.snapshot.thread.latestTurn?.state === "running") {
      const pending: StreamChunk[] = [];
      let wake: (() => void) | undefined;
      let completed = false;
      let failure: unknown;
      const notify = () => {
        wake?.();
        wake = undefined;
      };
      const waiter = input.gateway.waitForTerminal({
        turn,
        signal: input.signal,
        onSnapshot(snapshot) {
          pending.push(...projector.project(snapshot));
          notify();
        },
      }).then(
        (terminal) => {
          pending.push(...projector.project(terminal));
          completed = true;
          notify();
        },
        (error) => {
          failure = error;
          completed = true;
          notify();
        },
      );
      while (!completed || pending.length > 0) {
        if (pending.length === 0) {
          if (completed) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        yield pending.shift()!;
      }
      await waiter;
      if (failure) throw failure;
    }
  } catch (error) {
    yield {
      type: EventType.RUN_ERROR,
      runId: input.runId,
      message: error instanceof Error ? error.message : "Native T3 recovery failed.",
      timestamp: Date.now(),
    };
  } finally {
    await input.onTerminal?.();
  }
}

/**
 * Project one central hosted-T3 turn onto the legacy AG-UI wire contract.
 * The central orchestration log remains authoritative; this stream is only a
 * resumable compatibility view for existing HTTP clients.
 */
export async function* createCentralT3AguiStream(
  input: CentralT3AguiStreamInput,
): AsyncIterable<StreamChunk> {
  yield {
    type: EventType.RUN_STARTED,
    runId: input.runId,
    threadId: input.canonicalThreadId,
    timestamp: Date.now(),
  };

  const pending: StreamChunk[] = [];
  let wake: (() => void) | undefined;
  let completed = false;
  let failure: unknown;
  let projector: NativeT3SnapshotProjector | undefined;
  let projectedTerminal = false;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  const project = (snapshot: T3ThreadSnapshot) => {
    if (!projector) return;
    const events = projector.project(snapshot);
    if (
      events.some(
        (event) =>
          event.type === EventType.RUN_FINISHED ||
          event.type === EventType.RUN_ERROR,
      )
    ) {
      projectedTerminal = true;
    }
    pending.push(...events);
    notify();
  };

  const conversation = runCentralT3Conversation({
    client: input.client,
    canonicalThreadId: input.canonicalThreadId,
    title: input.title,
    prompt: input.text,
    displayText: input.displayText,
    attribution: input.attribution,
    profile: input.profile,
    modelSelection: input.modelSelection,
    entrypoint: "api",
    idFactory: () => input.runId,
    signal: input.signal,
    onPrepared: input.onPrepared,
    async onDispatched(prepared, dispatch) {
      projector = new NativeT3SnapshotProjector(
        input.runId,
        input.canonicalThreadId,
        dispatch.messageId,
      );
      await input.onDispatched?.(prepared, dispatch);
    },
    onSnapshot(snapshot) {
      project(snapshot);
    },
  }).then(
    (result) => {
      project(result.snapshot);
      completed = true;
      notify();
    },
    (error) => {
      failure = error;
      completed = true;
      notify();
    },
  );

  while (!completed || pending.length > 0) {
    if (pending.length === 0) {
      if (completed) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      continue;
    }
    yield pending.shift()!;
  }
  await conversation;
  if (failure && !projectedTerminal) {
    yield {
      type: EventType.RUN_ERROR,
      runId: input.runId,
      message:
        failure instanceof Error
          ? failure.message
          : "The central T3 run failed.",
      timestamp: Date.now(),
    };
  }
}

/**
 * Reattach the durable API compatibility stream to its deterministic central
 * T3 message. A running snapshot seeds projector state without replaying the
 * prefix; a terminal startup snapshot emits only its terminal outcome because
 * the complete transcript remains authoritative in central T3.
 */
export async function* createCentralT3AguiRecoveryStream(
  input: CentralT3AguiRecoveryStreamInput,
): AsyncIterable<StreamChunk> {
  const threadId = centralT3ThreadId(input.canonicalThreadId);
  const messageId = centralT3ApiMessageId(input.runId);
  const initial = await input.client.threadSnapshot(threadId, input.signal);
  const requestedMessage = initial.thread.messages.find(
    (message) => message.id === messageId && message.role === "user",
  );
  if (!requestedMessage) {
    throw new Error(
      `Central T3 compatibility run ${input.runId} has no matching user message`,
    );
  }
  const projector = new NativeT3SnapshotProjector(
    input.runId,
    input.canonicalThreadId,
    messageId,
  );
  const initialEvents = projector.project(initial);
  const initialTerminal = initialEvents.some(
    (event) =>
      event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR,
  );
  if (initialTerminal) {
    const terminalEvent = [...initialEvents]
      .reverse()
      .find(
        (event) =>
          event.type === EventType.RUN_FINISHED ||
          event.type === EventType.RUN_ERROR,
      );
    if (terminalEvent) yield terminalEvent;
    return;
  }

  // The durable prefix already contains everything visible before takeover.
  // Discard the initial projection so only subsequent deltas are appended.
  const pending: StreamChunk[] = [];
  let wake: (() => void) | undefined;
  let completed = false;
  let failure: unknown;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  const waiter = input.client.waitForTurnTerminal({
    threadId,
    minimumSequence: initial.snapshotSequence,
    messageId,
    requestedAt: requestedMessage.createdAt,
    timeoutMs: CENTRAL_T3_TIMEOUT_MS,
    absoluteTimeoutMs: Math.max(
      1,
      centralT3AbsoluteTimeoutMs() - Math.max(0, Date.now() - input.startedAt),
    ),
    signal: input.signal,
    onSnapshot(snapshot) {
      pending.push(...projector.project(snapshot));
      notify();
    },
  }).then(
    (terminal) => {
      pending.push(...projector.project(terminal));
      completed = true;
      notify();
    },
    (error) => {
      failure = error;
      completed = true;
      notify();
    },
  );
  while (!completed || pending.length > 0) {
    if (pending.length === 0) {
      if (completed) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      continue;
    }
    yield pending.shift()!;
  }
  await waiter;
  if (failure) throw failure;
}
