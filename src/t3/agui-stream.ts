import {
  EventType,
  type StreamChunk,
} from "@tanstack/ai";
import type { T3ThreadSnapshot } from "./client.js";
import type { T3GatewayTurn } from "./gateway.js";

export interface NativeT3AguiGateway {
  send(input: {
    canonicalThreadId: string;
    title: string;
    text: string;
    modelSelection: { instanceId: string; model: string };
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
  modelSelection: { instanceId: string; model: string };
  signal?: AbortSignal;
  onTurn?(turn: T3GatewayTurn): void | Promise<void>;
  onTerminal?(): void | Promise<void>;
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

/**
 * Incremental projection from a native worker T3 snapshot into the provider
 * event stream consumed by the central T3 environment. The worker owns the
 * provider process; this projection deliberately emits only events that the
 * central orchestration log needs to render the thread.
 */
export class NativeT3SnapshotProjector {
  private turnId: string | undefined;
  private assistantMessageId: string | undefined;
  private assistantText = "";
  private assistantEnded = false;
  private terminal = false;
  private readonly seenActivities = new Set<string>();
  private readonly startedTools = new Set<string>();

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
      const toolName =
        stringValue(payload.detail) ??
        stringValue(payload.itemType) ??
        activity.summary ??
        "Tool";
      if (!this.startedTools.has(toolCallId)) {
        this.startedTools.add(toolCallId);
        chunks.push({
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName: toolName,
          toolName,
          timestamp: timestamp(activity.createdAt),
        });
        chunks.push({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: json(payload.data),
          args: json(payload.data),
          timestamp: timestamp(activity.createdAt),
        });
      }
      if (activity.kind === "tool.completed") {
        chunks.push({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId,
          messageId: activity.id,
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

    const assistant = snapshot.thread.messages.find(
      (message) => message.role === "assistant" && message.turnId === this.turnId,
    );
    if (assistant) {
      if (!this.assistantMessageId) {
        this.assistantMessageId = assistant.id;
        chunks.push({
          type: EventType.TEXT_MESSAGE_START,
          messageId: assistant.id,
          role: "assistant",
          timestamp: timestamp(assistant.createdAt),
        });
      }
      const delta = assistant.text.startsWith(this.assistantText)
        ? assistant.text.slice(this.assistantText.length)
        : assistant.text;
      if (delta) {
        this.assistantText = assistant.text;
        chunks.push({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: assistant.id,
          delta,
          content: assistant.text,
          timestamp: timestamp(assistant.updatedAt),
        });
      }
      if (!assistant.streaming && !this.assistantEnded) {
        this.assistantEnded = true;
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
    if (this.assistantMessageId && !this.assistantEnded) {
      this.assistantEnded = true;
      chunks.push({
        type: EventType.TEXT_MESSAGE_END,
        messageId: this.assistantMessageId,
        timestamp: timestamp(latestTurn.completedAt ?? undefined),
      });
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
