import path from "node:path";
import { chat, mergeAgentTools, type StreamChunk } from "@tanstack/ai";
import { claudeCodeText } from "@tanstack/ai-claude-code";
import { codexText } from "@tanstack/ai-codex";
import { withSandbox, type SandboxDefinition } from "@tanstack/ai-sandbox";
import { withPersistence, type ChatPersistence } from "@tanstack/ai-persistence";
import type { MCPClient } from "@tanstack/ai-mcp";
import { withLocks, type LockStore } from "@tanstack/ai/locks";
import {
  CODEX_MODEL,
  DEFAULT_MODEL,
  FABLE_MODEL,
} from "../config.js";
import { gitAuthenticationEnvironment } from "../repo.js";
import { resolveClaudeExecutable } from "./claude-executable.js";
import { resolveCodexExecutable } from "./codex-executable.js";
import {
  configuredAgentProvider,
  isAgentProfile,
  isAgentProvider,
  providerForAgentProfile,
  type AgentProvider,
  type AguiChatParams,
} from "./protocol.js";
import { createHarnessTelemetryMiddleware } from "./telemetry.js";
import {
  RUN_MEMORY_MODE,
  metadataRunMemoryStore,
  withRunMemory,
} from "./run-memory.js";
import { harnessLockStore } from "./thread-lock.js";
import { deferTerminalHooks } from "./middleware-order.js";

/** Trusted Compadre harnesses run non-interactively with no approval gates. */
export const CODEX_DANGEROUS_PERMISSIONS = {
  sandboxMode: "danger-full-access",
  approvalPolicy: "never",
  config: {
    "mcp_servers.tanstack.default_tools_approval_mode": '"approve"',
  },
} as const;

export const CLAUDE_DANGEROUS_PERMISSIONS = {
  permissionMode: "bypassPermissions",
} as const;

export interface HarnessSelection {
  provider: AgentProvider;
  model: string;
}

export interface CreateHarnessStreamOptions {
  selection: HarnessSelection;
  params: AguiChatParams;
  sessionId?: string;
  worktreePath: string;
  worktreeId: string;
  maxTurns?: number;
  clients: MCPClient[];
  sandbox: SandboxDefinition;
  abortController: AbortController;
  systemPrompt: string;
  persistence?: ChatPersistence;
  locks?: LockStore;
}

export function resolveHarnessSelection(
  forwardedProps: Record<string, unknown>,
): HarnessSelection {
  const profile = isAgentProfile(forwardedProps.profile)
    ? forwardedProps.profile
    : undefined;
  const provider = profile
    ? providerForAgentProfile(profile)
    : isAgentProvider(forwardedProps.provider)
      ? forwardedProps.provider
      : configuredAgentProvider();
  const requestedModel = forwardedProps.model;

  let model: string;
  if (provider === "codex") {
    model = requestedModel === CODEX_MODEL ? requestedModel : CODEX_MODEL;
  } else if (profile === "fable" || requestedModel === FABLE_MODEL) {
    model = FABLE_MODEL;
  } else {
    model = requestedModel === DEFAULT_MODEL ? requestedModel : DEFAULT_MODEL;
  }

  return { provider, model };
}

function codexReasoningEffort(): "minimal" | "low" | "medium" | "high" {
  const value = process.env.CODEX_REASONING_EFFORT;
  return value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high"
    ? value
    : "high";
}

/**
 * Identify Compadre-owned harnesses to repository hooks. Dependency setup is
 * kept off the startup path and remains available explicitly to the agent.
 */
export function harnessEnvironment(
  worktreePath: string,
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    ...gitAuthenticationEnvironment(environment),
    COMPADRE_SKIP_WORKTREE_SETUP: "1",
    GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(worktreePath)),
  };
}

/**
 * The only provider-specific branch in the AG-UI runtime. Everything outside
 * this function—transport, worktrees, MCP, sessions, cancellation, and
 * observability—is shared between harnesses.
 */
export function createHarnessStream({
  selection,
  params,
  sessionId,
  worktreePath,
  worktreeId,
  maxTurns,
  clients,
  sandbox,
  abortController,
  systemPrompt,
  persistence,
  locks = harnessLockStore,
}: CreateHarnessStreamOptions): AsyncIterable<StreamChunk> {
  const telemetry = createHarnessTelemetryMiddleware({
    selection,
    threadId: params.threadId,
    runId: params.runId,
    worktreeId,
  });
  const persistenceMiddleware = persistence
    ? deferTerminalHooks(withPersistence(persistence))
    : undefined;
  const runMemory =
    persistence && RUN_MEMORY_MODE !== "off"
      ? withRunMemory(metadataRunMemoryStore(persistence.stores.metadata), {
          ...(RUN_MEMORY_MODE === "observe"
            ? { shouldInject: () => false }
            : {}),
        })
      : undefined;
  const shared = {
    messages: params.messages,
    systemPrompts: [systemPrompt],
    tools: mergeAgentTools([], params.tools),
    mcp: { clients },
    middleware: [
      // Persistence loads history and provides pending-turn state before the
      // sandbox starts, but must save only after the sandbox reconciles tools.
      ...(persistenceMiddleware ? [persistenceMiddleware.lifecycle] : []),
      ...(runMemory ? [runMemory] : []),
      withLocks(locks),
      withSandbox(sandbox),
      ...(persistenceMiddleware ? [persistenceMiddleware.terminal] : []),
      ...telemetry,
    ],
    threadId: params.threadId,
    runId: params.runId,
    parentRunId: params.parentRunId,
    state: params.state,
    resume: params.resume,
    abortController,
    stream: true as const,
  };

  if (selection.provider === "codex") {
    return chat({
      ...shared,
      adapter: codexText(selection.model, {
        codexExecutable: resolveCodexExecutable(),
        ...CODEX_DANGEROUS_PERMISSIONS,
        networkAccessEnabled: true,
        webSearchMode: "live",
        modelReasoningEffort: codexReasoningEffort(),
        env: harnessEnvironment(worktreePath),
      }),
      modelOptions: {
        modelReasoningEffort: codexReasoningEffort(),
        ...(sessionId ? { sessionId } : {}),
      },
    });
  }

  return chat({
    ...shared,
    adapter: claudeCodeText(selection.model, {
      claudeExecutable: resolveClaudeExecutable(),
      ...CLAUDE_DANGEROUS_PERMISSIONS,
      systemPromptMode: "replace",
      ...(maxTurns === undefined ? {} : { maxTurns }),
      env: harnessEnvironment(worktreePath),
    }),
    modelOptions: {
      ...(maxTurns === undefined ? {} : { maxTurns }),
      ...(sessionId ? { sessionId } : {}),
    },
  });
}
