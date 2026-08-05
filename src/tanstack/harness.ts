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
  isAgentProvider,
  type AgentProvider,
  type AguiChatParams,
} from "./protocol.js";
import { createHarnessTelemetryMiddleware } from "./telemetry.js";
import { harnessLockStore } from "./thread-lock.js";

const FABLE_FLAG_PATTERN = /--fable/g;

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

function textFromMessage(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const record = message as {
    role?: unknown;
    content?: unknown;
    parts?: unknown;
  };
  if (record.role !== "user") return "";
  if (typeof record.content === "string") return record.content;

  const blocks = Array.isArray(record.content)
    ? record.content
    : Array.isArray(record.parts)
      ? record.parts
      : [];
  return blocks
    .map((block) => {
      if (typeof block !== "object" || block === null) return "";
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}

function hasFableFlag(messages: unknown): boolean {
  return (
    Array.isArray(messages) &&
    [...messages]
      .reverse()
      .some((message) => textFromMessage(message).includes("--fable"))
  );
}

export function cleanFableControlText(text: string): string {
  if (!text.includes("--fable")) return text;
  const cleaned = text
    .replace(FABLE_FLAG_PATTERN, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned || text;
}

function cleanTextBlocks(blocks: unknown[]): unknown[] {
  let changed = false;
  const cleaned = blocks.map((block) => {
    if (typeof block !== "object" || block === null) return block;
    const record = block as { text?: unknown };
    if (typeof record.text !== "string" || !record.text.includes("--fable")) {
      return block;
    }
    changed = true;
    return { ...record, text: cleanFableControlText(record.text) };
  });
  return changed ? cleaned : blocks;
}

/** Remove the model-selection control flag before either harness sees it. */
export function messagesWithoutFableFlag(
  messages: AguiChatParams["messages"]
): AguiChatParams["messages"] {
  return messages.map((message) => {
    const record = message as unknown as {
      role?: unknown;
      content?: unknown;
      parts?: unknown;
    };
    if (record.role !== "user") return message;
    if (typeof record.content === "string") {
      return {
        ...record,
        content: cleanFableControlText(record.content),
      } as typeof message;
    }
    if (Array.isArray(record.content)) {
      return {
        ...record,
        content: cleanTextBlocks(record.content),
      } as typeof message;
    }
    if (Array.isArray(record.parts)) {
      return {
        ...record,
        parts: cleanTextBlocks(record.parts),
      } as typeof message;
    }
    return message;
  });
}

export function resolveHarnessSelection(
  forwardedProps: Record<string, unknown>,
  messages: unknown
): HarnessSelection {
  const provider = isAgentProvider(forwardedProps.provider)
    ? forwardedProps.provider
    : configuredAgentProvider();
  const requestedModel = forwardedProps.model;

  let model: string;
  if (provider === "codex") {
    model = requestedModel === CODEX_MODEL ? requestedModel : CODEX_MODEL;
  } else if (
    forwardedProps.fable === true ||
    hasFableFlag(messages) ||
    requestedModel === FABLE_MODEL
  ) {
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
    messages: messagesWithoutFableFlag(params.messages),
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
