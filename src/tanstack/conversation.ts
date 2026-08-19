import crypto from "node:crypto";
import { EventType, type StreamChunk } from "@tanstack/ai";
import { AGENT_EXECUTION_TIMEOUT_MS } from "../agent-timeouts.js";
import type { StreamCallbacks } from "../conversation.js";
import { AssistantMessageAccumulator } from "./assistant-messages.js";
import {
  providerForAgentProfile,
  sessionIdFromChunk,
  type AgentProfile,
  type AgentProvider,
  type AguiChatParams,
} from "./protocol.js";
import { runAguiChat } from "./runtime.js";
import {
  captureDurableRun,
  getConfiguredAgentRunDurability,
} from "../durability/runtime.js";
import type { RunCapacityPriority } from "./thread-lock.js";
import type { SlackFileReference } from "../services/slack-files.js";

export interface HarnessConversationOptions {
  runId?: string;
  threadId: string;
  prompt: string;
  transcriptUserMessage: string;
  provider?: AgentProvider;
  profile?: AgentProfile;
  signal?: AbortSignal;
  systemPrompt?: (worktreePath: string) => string;
  stream?: StreamCallbacks;
  capacityPriority?: RunCapacityPriority;
  persistThread?: boolean;
  slackFiles?: SlackFileReference[];
}

export interface HarnessConversationResult {
  runId: string;
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
  runId: string;
  provider: AgentProvider;
  startedAt: number;
  stream?: StreamCallbacks;
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
    try {
      for await (const chunk of chunks) {
        if (chunk.model) model = chunk.model;
        assistantMessages.observe(chunk);

        const nextSessionId = sessionIdFromChunk(chunk, options.provider);
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
          if (!finished) {
            throw new Error(chunk.message || "Agent run failed");
          }
          console.warn("[conversation] ignored error after final run event", {
            runId: options.runId,
            error: chunk.message,
          });
        } else if (
          chunk.type === EventType.RUN_FINISHED &&
          chunk.finishReason !== "tool_calls"
        ) {
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
    } catch (error) {
      if (!finished) throw error;
      console.warn("[conversation] ignored failure after final run event", {
        runId: options.runId,
        error,
      });
    }

    if (!finished) throw new Error("Agent stream ended without a terminal event");

    return {
      runId: options.runId,
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

export async function runHarnessConversation(
  options: HarnessConversationOptions
): Promise<HarnessConversationResult> {
  const provider = options.profile
    ? providerForAgentProfile(options.profile)
    : options.provider ?? "claude-code";
  const runId = options.runId ?? crypto.randomUUID();
  const abortController = new AbortController();
  const abort = () => abortController.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();

  const timer = setTimeout(() => {
    abortController.abort(
      new Error(`Agent run exceeded ${AGENT_EXECUTION_TIMEOUT_MS}ms execution limit`)
    );
  }, AGENT_EXECUTION_TIMEOUT_MS);
  timer.unref();

  const params: AguiChatParams = {
    messages: [{ role: "user", content: options.prompt }],
    threadId: options.threadId,
    runId,
    tools: [],
    forwardedProps: {
      provider,
      ...(options.profile ? { profile: options.profile } : {}),
    },
    state: {},
    context: [],
    aguiContext: [],
  };

  try {
    const startedAt = Date.now();
    // Durability is a required production capability when configured. Resolve
    // it before allocating a worktree or starting a harness so a database
    // outage cannot leave an unconsumed agent stream and its resources behind.
    const durability = await getConfiguredAgentRunDurability();
    const chunks = await runAguiChat(params, abortController.signal, {
      systemPrompt: options.systemPrompt,
      transcriptUserMessage: options.transcriptUserMessage,
      capacityPriority: options.capacityPriority,
      persistThread: options.persistThread,
      slackFiles: options.slackFiles,
    });
    const consumableChunks = durability
      ? captureDurableRun(chunks, {
          runId,
          threadId: options.threadId,
          signal: abortController.signal,
          durability,
        })
      : chunks;
    return await consumeHarnessConversation(consumableChunks, {
      runId,
      provider,
      startedAt,
      stream: options.stream,
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
