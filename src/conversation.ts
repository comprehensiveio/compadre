import crypto from "node:crypto";
import {
  runHarnessConversation,
  type HarnessConversationResult,
} from "./tanstack/conversation.js";
import { isAgentProvider, type AgentProvider } from "./tanstack/protocol.js";
import { releaseAguiThread } from "./tanstack/runtime.js";

export interface StreamCallbacks {
  onTextDelta?: (text: string) => void;
  onToolStart?: (toolName: string) => void;
  onComplete?: () => void | Promise<void>;
}

export interface ConversationOptions {
  prompt: string;
  threadId?: string;
  provider?: AgentProvider;
  maxTurns?: number;
  signal?: AbortSignal;
  systemPrompt?: (worktreePath: string) => string;
  stream?: StreamCallbacks;
}

export type ConversationResult = HarnessConversationResult;

const threadRuns = new Map<string, Promise<unknown>>();

export function configuredAgentProvider(): AgentProvider {
  return isAgentProvider(process.env.COMPADRE_AGENT_PROVIDER)
    ? process.env.COMPADRE_AGENT_PROVIDER
    : "claude-code";
}

export function validateConversationConfiguration(): {
  provider: AgentProvider;
} {
  const configuredProvider = process.env.COMPADRE_AGENT_PROVIDER;
  if (
    configuredProvider !== undefined &&
    !isAgentProvider(configuredProvider)
  ) {
    throw new Error(
      "COMPADRE_AGENT_PROVIDER must be 'claude-code' or 'codex'"
    );
  }
  return { provider: configuredAgentProvider() };
}

async function serializeThread<T>(
  threadId: string,
  run: () => Promise<T>
): Promise<T> {
  const previous = threadRuns.get(threadId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(run);
  threadRuns.set(threadId, current);
  try {
    return await current;
  } finally {
    if (threadRuns.get(threadId) === current) threadRuns.delete(threadId);
  }
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

  return options.threadId ? serializeThread(threadId, run) : run();
}
