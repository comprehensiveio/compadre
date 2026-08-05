import crypto from "node:crypto";
import {
  runHarnessConversation,
  type HarnessConversationResult,
} from "./tanstack/conversation.js";
import {
  configuredAgentProvider,
  validateAgentProviderConfiguration,
  type AgentProvider,
} from "./tanstack/protocol.js";
import { releaseAguiThread } from "./tanstack/runtime.js";

export interface StreamCallbacks {
  onTextDelta?: (text: string) => void;
  onToolStart?: (toolName: string) => void;
  onComplete?: () => void | Promise<void>;
}

export interface ConversationOptions {
  prompt: string;
  transcriptUserMessage?: string;
  threadId?: string;
  provider?: AgentProvider;
  maxTurns?: number;
  signal?: AbortSignal;
  systemPrompt?: (worktreePath: string) => string;
  stream?: StreamCallbacks;
}

export type ConversationResult = HarnessConversationResult;

export { configuredAgentProvider } from "./tanstack/protocol.js";

export function validateConversationConfiguration(): {
  provider: AgentProvider;
} {
  return validateAgentProviderConfiguration();
}

export function runConversation(
  options: ConversationOptions
): Promise<ConversationResult> {
  const ephemeral = !options.threadId;
  const threadId = options.threadId ?? `prompt-${crypto.randomUUID()}`;
  const run = async () => {
    try {
      return await runHarnessConversation({
        threadId,
        prompt: options.prompt,
        transcriptUserMessage:
          options.transcriptUserMessage ?? options.prompt,
        provider: options.provider ?? configuredAgentProvider(),
        maxTurns: options.maxTurns,
        signal: options.signal,
        systemPrompt: options.systemPrompt,
        stream: options.stream,
      });
    } finally {
      if (ephemeral) await releaseAguiThread(threadId);
    }
  };

  return run();
}
