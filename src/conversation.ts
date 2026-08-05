import crypto from "node:crypto";
import {
  runTask,
  type RunTaskOptions,
  type StreamCallbacks,
  type TaskResult,
} from "./agent.js";
import {
  DEFAULT_MAX_BUDGET_USD,
  DEFAULT_MAX_TURNS,
} from "./config.js";
import { createWorktree, removeWorktree } from "./repo.js";
import { getSession, setSession } from "./sessions.js";
import {
  runHarnessConversation,
  type HarnessConversationResult,
} from "./tanstack/conversation.js";
import { isAgentProvider, type AgentProvider } from "./tanstack/protocol.js";
import { releaseAguiThread } from "./tanstack/runtime.js";

export type ConversationRuntime = "legacy" | "tanstack";

export interface ConversationOptions {
  prompt: string;
  threadId?: string;
  sessionId?: string;
  runtime?: ConversationRuntime;
  provider?: AgentProvider;
  maxTurns?: number;
  maxBudgetUsd?: number;
  signal?: AbortSignal;
  systemPrompt?: (worktreePath: string) => string;
  stream?: StreamCallbacks;
}

export interface ConversationResult extends TaskResult {
  runtime: ConversationRuntime;
  provider: "claude-agent-sdk" | AgentProvider;
  model?: string;
  finishReason?: HarnessConversationResult["finishReason"];
  budgetEnforced: boolean;
}

const threadRuns = new Map<string, Promise<unknown>>();

export function configuredConversationRuntime(): ConversationRuntime {
  return process.env.COMPADRE_AGENT_RUNTIME === "tanstack"
    ? "tanstack"
    : "legacy";
}

export function configuredAgentProvider(): AgentProvider {
  return isAgentProvider(process.env.COMPADRE_AGENT_PROVIDER)
    ? process.env.COMPADRE_AGENT_PROVIDER
    : "claude-code";
}

/**
 * An optional Slack user allowlist narrows TanStack traffic without changing
 * the global runtime. While configured, every non-allowlisted Slack user stays
 * on the legacy runtime even if the global default is TanStack.
 */
export function conversationRuntimeForSlackUser(
  userId: string | undefined
): ConversationRuntime {
  const configuredUsers = process.env.COMPADRE_TANSTACK_SLACK_USER_IDS;
  if (!configuredUsers?.trim()) return configuredConversationRuntime();

  const allowlisted = configuredUsers
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return userId && allowlisted.includes(userId) ? "tanstack" : "legacy";
}

export function validateConversationConfiguration(): {
  runtime: ConversationRuntime;
  provider: AgentProvider;
} {
  const configuredRuntime = process.env.COMPADRE_AGENT_RUNTIME;
  if (
    configuredRuntime !== undefined &&
    configuredRuntime !== "legacy" &&
    configuredRuntime !== "tanstack"
  ) {
    throw new Error(
      "COMPADRE_AGENT_RUNTIME must be 'legacy' or 'tanstack'"
    );
  }
  const runtime = configuredConversationRuntime();
  const configuredProvider = process.env.COMPADRE_AGENT_PROVIDER;
  const hasSlackCanary = Boolean(
    process.env.COMPADRE_TANSTACK_SLACK_USER_IDS?.trim()
  );
  if (
    (runtime === "tanstack" || hasSlackCanary) &&
    configuredProvider !== undefined &&
    !isAgentProvider(configuredProvider)
  ) {
    throw new Error(
      "COMPADRE_AGENT_PROVIDER must be 'claude-code' or 'codex'"
    );
  }
  return { runtime, provider: configuredAgentProvider() };
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

async function runLegacyConversation(
  options: ConversationOptions
): Promise<ConversationResult> {
  let sessionId = options.sessionId;
  const existing = !sessionId && options.threadId
    ? getSession(options.threadId)
    : undefined;
  sessionId ??= existing?.sessionId;
  const worktreeId = existing?.worktreeId ?? crypto.randomUUID();
  const worktreePath = createWorktree(worktreeId);
  const taskOptions: RunTaskOptions = {
    prompt: options.prompt,
    sessionId,
    systemPrompt: options.systemPrompt?.(worktreePath),
    worktreePath,
    maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
    maxBudgetUsd: options.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD,
    stream: options.stream,
  };

  try {
    const result = await runTask(taskOptions);
    if (options.threadId && result.sessionId) {
      setSession(options.threadId, { sessionId: result.sessionId, worktreeId });
    } else {
      removeWorktree(worktreeId);
    }
    return {
      ...result,
      runtime: "legacy",
      provider: "claude-agent-sdk",
      budgetEnforced: true,
    };
  } catch (error) {
    if (!options.threadId || !getSession(options.threadId)) {
      removeWorktree(worktreeId);
    }
    throw error;
  }
}

async function runTanStackConversation(
  options: ConversationOptions
): Promise<ConversationResult> {
  if (options.sessionId) {
    throw new Error(
      "Explicit provider-native sessionId is not supported by the TanStack runtime; use threadId"
    );
  }

  const ephemeral = !options.threadId;
  const threadId = options.threadId ?? `prompt-${crypto.randomUUID()}`;
  try {
    const result = await runHarnessConversation({
      threadId,
      prompt: options.prompt,
      provider: options.provider ?? configuredAgentProvider(),
      maxTurns: options.maxTurns,
      signal: options.signal,
      systemPrompt: options.systemPrompt,
      stream: options.stream,
    });
    return {
      result: result.result,
      sessionId: result.sessionId,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
      runtime: "tanstack",
      provider: result.provider,
      model: result.model,
      finishReason: result.finishReason,
      budgetEnforced: false,
    };
  } finally {
    if (ephemeral) await releaseAguiThread(threadId);
  }
}

export function runConversation(
  options: ConversationOptions
): Promise<ConversationResult> {
  const runtime = options.runtime ?? configuredConversationRuntime();
  const run = () =>
    runtime === "tanstack"
      ? runTanStackConversation(options)
      : runLegacyConversation(options);
  return options.threadId ? serializeThread(options.threadId, run) : run();
}
