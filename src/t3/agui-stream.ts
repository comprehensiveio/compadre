import { EventType, type StreamChunk } from "./agui-protocol.js";
import {
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  trace as otelTrace,
  type Context,
  type Tracer,
} from "@opentelemetry/api";
import type { T3ModelSelection, T3ThreadSnapshot } from "./client.js";
import type { T3GatewayTurn } from "./gateway.js";

export interface NativeT3AguiGateway {
  send(input: {
    canonicalThreadId: string;
    title: string;
    text: string;
    modelSelection: T3ModelSelection;
    signal?: AbortSignal;
  }): Promise<T3GatewayTurn>;
  waitForTerminal(input: {
    turn: T3GatewayTurn;
    timeoutMs?: number;
    signal?: AbortSignal;
    onSnapshot?(snapshot: T3ThreadSnapshot): void | Promise<void>;
  }): Promise<T3ThreadSnapshot>;
}

export interface NativeT3AguiStreamInput {
  gateway: NativeT3AguiGateway;
  canonicalThreadId: string;
  runId: string;
  title: string;
  text: string;
  modelSelection: T3ModelSelection;
  signal?: AbortSignal;
  onTurn?(turn: T3GatewayTurn): void | Promise<void>;
  onTerminal?(): void | Promise<void>;
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
    this.turnId = requestedMessage.turnId ?? this.turnId ?? snapshot.thread.latestTurn?.turnId;
    if (!this.turnId) return [];

    const chunks: StreamChunk[] = [];
    for (const activity of activities(snapshot)) {
      if (activity.turnId !== this.turnId || this.seenActivities.has(activity.id)) continue;
      this.seenActivities.add(activity.id);
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
      (message) => message.role === "assistant" && message.turnId === this.turnId,
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
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      yield pending.shift()!;
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
