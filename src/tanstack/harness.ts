import path from "node:path";
import { chat, mergeAgentTools, type StreamChunk } from "@tanstack/ai";
import { claudeCodeText } from "@tanstack/ai-claude-code";
import { codexText } from "@tanstack/ai-codex";
import { withSandbox, type SandboxDefinition } from "@tanstack/ai-sandbox";
import type { MCPClient } from "@tanstack/ai-mcp";
import { withLocks } from "@tanstack/ai/locks";
import {
  CODEX_MODEL,
  DEFAULT_MODEL,
  FABLE_MODEL,
} from "../config.js";
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
import { harnessLockStore } from "./thread-lock.js";

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
  maxTurns: number;
  clients: MCPClient[];
  sandbox: SandboxDefinition;
  abortController: AbortController;
  systemPrompt: string;
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
}: CreateHarnessStreamOptions): AsyncIterable<StreamChunk> {
  const telemetry = createHarnessTelemetryMiddleware({
    selection,
    threadId: params.threadId,
    runId: params.runId,
    worktreeId,
  });
  const shared = {
    messages: params.messages,
    systemPrompts: [systemPrompt],
    tools: mergeAgentTools([], params.tools),
    mcp: { clients },
    middleware: [
      withLocks(harnessLockStore),
      withSandbox(sandbox),
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
        env: {
          GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(worktreePath)),
        },
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
      maxTurns,
      env: {
        GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(worktreePath)),
      },
    }),
    modelOptions: {
      maxTurns,
      ...(sessionId ? { sessionId } : {}),
    },
  });
}
