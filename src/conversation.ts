import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  runHarnessConversation,
  type HarnessConversationResult,
} from "./tanstack/conversation.js";
import {
  configuredAgentProvider,
  validateAgentProviderConfiguration,
  type AgentProfile,
  type AgentProvider,
} from "./tanstack/protocol.js";
import { releaseAguiThread } from "./tanstack/runtime.js";
import {
  BackgroundCapacityPreemptedError,
  type RunCapacityPriority,
} from "./tanstack/thread-lock.js";

export interface StreamCallbacks {
  onTextDelta?: (text: string) => void;
  onToolStart?: (toolName: string) => void;
  onComplete?: () => void | Promise<void>;
}

export interface ConversationOptions {
  runId?: string;
  prompt: string;
  transcriptUserMessage?: string;
  threadId?: string;
  provider?: AgentProvider;
  profile?: AgentProfile;
  signal?: AbortSignal;
  systemPrompt?: (worktreePath: string) => string;
  stream?: StreamCallbacks;
  capacityPriority?: RunCapacityPriority;
  retryOnBackgroundPreemption?: boolean;
  persistThread?: boolean;
}

export type ConversationResult = HarnessConversationResult;

export { configuredAgentProvider } from "./tanstack/protocol.js";

export function validateConversationConfiguration(): {
  provider: AgentProvider;
} {
  return validateAgentProviderConfiguration();
}

export async function retryBackgroundPreemptions<T>(
  task: () => Promise<T>,
  onPreempted: (attempt: number) => void | Promise<void> = async () => {
    await delay(100);
  },
  signal?: AbortSignal,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await task();
    } catch (error) {
      if (!(error instanceof BackgroundCapacityPreemptedError)) throw error;
      if (signal?.aborted) throw signal.reason;
      attempt += 1;
      await onPreempted(attempt);
      if (signal?.aborted) throw signal.reason;
    }
  }
}

export function runConversation(
  options: ConversationOptions
): Promise<ConversationResult> {
  const ephemeral = !options.threadId;
  const threadId = options.threadId ?? `prompt-${crypto.randomUUID()}`;
  const run = async () => {
    try {
      const execute = () => runHarnessConversation({
        runId: options.runId,
        threadId,
        prompt: options.prompt,
        transcriptUserMessage:
          options.transcriptUserMessage ?? options.prompt,
        provider: options.provider ?? configuredAgentProvider(),
        profile: options.profile,
        signal: options.signal,
        systemPrompt: options.systemPrompt,
        stream: options.stream,
        capacityPriority: options.capacityPriority,
        persistThread: options.persistThread ?? !ephemeral,
      });
      if (!options.retryOnBackgroundPreemption) return await execute();
      return await retryBackgroundPreemptions(
        execute,
        async (attempt) => {
          console.warn(
            `[conversation] background run preempted; retrying attempt=${attempt}`,
          );
          await delay(100);
        },
        options.signal,
      );
    } finally {
      if (ephemeral) await releaseAguiThread(threadId);
    }
  };

  return run();
}
