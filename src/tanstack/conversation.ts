import crypto from "node:crypto";
import { EventType, type StreamChunk } from "@tanstack/ai";
import { DEFAULT_MAX_TURNS } from "../config.js";
import type { StreamCallbacks } from "../conversation.js";
import { AssistantMessageAccumulator } from "./assistant-messages.js";
import type { AgentProvider, AguiChatParams } from "./protocol.js";
import { runAguiChat } from "./runtime.js";

export interface HarnessConversationOptions {
  threadId: string;
  prompt: string;
  provider?: AgentProvider;
  maxTurns?: number;
  signal?: AbortSignal;
  systemPrompt?: (worktreePath: string) => string;
  stream?: StreamCallbacks;
}

export interface HarnessConversationResult {
  result: string;
  sessionId: string;
  provider: AgentProvider;
  model: string;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  finishReason: "stop" | "length" | "content_filter" | "tool_calls" | null;
}

interface ConsumeOptions {
  provider: AgentProvider;
  startedAt: number;
  stream?: StreamCallbacks;
}

function sessionIdFrom(chunk: StreamChunk): string | undefined {
  if (
    chunk.type !== EventType.CUSTOM ||
    (chunk.name !== "claude-code.session-id" &&
      chunk.name !== "codex.session-id") ||
    typeof chunk.value !== "object" ||
    chunk.value === null
  ) {
    return undefined;
  }
  const sessionId = (chunk.value as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" ? sessionId : undefined;
}

/**
 * Translate the AG-UI event stream into Compadre's channel-neutral streaming
 * interface. Callers never need to understand provider or AG-UI event shapes.
 */
export async function consumeHarnessConversation(
  chunks: AsyncIterable<StreamChunk>,
  options: ConsumeOptions
): Promise<HarnessConversationResult> {
  let text = "";
  let sessionId = "";
  let model = "";
  let costUsd = 0;
  let numTurns = 0;
  let finished = false;
  let finishReason: HarnessConversationResult["finishReason"] = null;
  let activeMessageId: string | undefined;
  const assistantMessages = new AssistantMessageAccumulator();

  try {
    for await (const chunk of chunks) {
      if (chunk.model) model = chunk.model;
      assistantMessages.observe(chunk);

      const nextSessionId = sessionIdFrom(chunk);
      if (nextSessionId) sessionId = nextSessionId;

      if (chunk.type === EventType.TEXT_MESSAGE_START) {
        if (activeMessageId !== chunk.messageId) {
          activeMessageId = chunk.messageId;
          numTurns += 1;
          if (text.length > 0) {
            text += "\n\n";
            if (options.provider !== "codex") {
              options.stream?.onTextDelta?.("\n\n");
            }
          }
        }
      } else if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
        text += chunk.delta;
        // Codex emits completed progress notes and the terminal response as
        // indistinguishable agent_message items. Buffer them until the run
        // finishes so channel callers publish only the terminal message.
        if (options.provider !== "codex") {
          options.stream?.onTextDelta?.(chunk.delta);
        }
      } else if (chunk.type === EventType.TOOL_CALL_START) {
        options.stream?.onToolStart?.(chunk.toolCallName);
      } else if (chunk.type === EventType.RUN_ERROR) {
        throw new Error(chunk.message || "Agent run failed");
      } else if (chunk.type === EventType.RUN_FINISHED) {
        finished = true;
        finishReason = chunk.finishReason ?? null;
        if (options.provider === "codex") {
          options.stream?.onTextDelta?.(assistantMessages.terminalText());
        }
        const reportedCost =
          chunk.usage?.providerUsageDetails?.totalCostUsd;
        if (typeof reportedCost === "number") costUsd = reportedCost;
      }
    }

    if (!finished) throw new Error("Agent stream ended without a terminal event");

    return {
      result:
        options.provider === "codex"
          ? assistantMessages.terminalText()
          : text,
      sessionId,
      provider: options.provider,
      model,
      costUsd,
      durationMs: Date.now() - options.startedAt,
      numTurns,
      finishReason,
    };
  } finally {
    await options.stream?.onComplete?.();
  }
}

function positiveMaxTurns(value: number | undefined): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? Math.min(value, DEFAULT_MAX_TURNS)
    : DEFAULT_MAX_TURNS;
}

function maxDurationMs(): number {
  const configured = Number(process.env.COMPADRE_AGENT_MAX_DURATION_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : 15 * 60 * 1000;
}

export async function runHarnessConversation(
  options: HarnessConversationOptions
): Promise<HarnessConversationResult> {
  const provider = options.provider ?? "claude-code";
  const runId = crypto.randomUUID();
  const abortController = new AbortController();
  const abort = () => abortController.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();

  const timer = setTimeout(() => {
    abortController.abort(
      new Error(`Agent run exceeded ${maxDurationMs()}ms execution limit`)
    );
  }, maxDurationMs());
  timer.unref();

  const params: AguiChatParams = {
    messages: [{ role: "user", content: options.prompt }],
    threadId: options.threadId,
    runId,
    tools: [],
    forwardedProps: {
      provider,
      maxTurns: positiveMaxTurns(options.maxTurns),
    },
    state: {},
  };

  try {
    const startedAt = Date.now();
    const chunks = await runAguiChat(params, abortController.signal, {
      systemPrompt: options.systemPrompt,
      transcriptUserPrompt: options.prompt,
    });
    return await consumeHarnessConversation(chunks, {
      provider,
      startedAt,
      stream: options.stream,
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
