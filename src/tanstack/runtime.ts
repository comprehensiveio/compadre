import crypto from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import { EventType, type StreamChunk } from "@tanstack/ai";
import {
  defineSandbox,
  defineWorkspace,
} from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import { DEFAULT_MAX_TURNS } from "../config.js";
import { getBaseSystemPrompt } from "../prompts/index.js";
import { createWorktree, removeWorktree } from "../repo.js";
import {
  cleanFableControlText,
  createHarnessStream,
  resolveHarnessSelection,
  type HarnessSelection,
} from "./harness.js";
import { buildTanStackMcpClients } from "./mcp.js";
import { AssistantMessageAccumulator } from "./assistant-messages.js";
import type { AguiChatParams } from "./protocol.js";
import {
  harnessThreadStore,
  resumableHarnessSession,
  type HarnessTranscriptMessage,
} from "./thread-state.js";

export interface AguiRuntimeOptions {
  systemPrompt?: (worktreePath: string) => string;
  transcriptUserPrompt?: string;
}

/**
 * Build the provider-neutral workspace boundary shared by every coding
 * harness. The comp repo's setup script is intentionally idempotent and also
 * remains wired to Claude's SessionStart hook for non-Compadre callers.
 */
export function createHarnessSandbox(
  worktreeId: string,
  worktreePath: string
) {
  return defineSandbox({
    id: `compadre-agui-${worktreeId}`,
    provider: localProcessSandbox({
      dir: worktreePath,
      removeOnDestroy: false,
    }),
    workspace: defineWorkspace({
      source: { type: "local", path: worktreePath },
      setup: ["scripts/worktree-up.sh --hook"],
    }),
    lifecycle: {
      reuse: "thread",
      snapshot: "none",
      destroyOnComplete: false,
    },
    // Harness events already describe edits. Disable the extra filesystem
    // watcher to avoid duplicate events and watcher overhead for this spike.
    fileEvents: false,
  });
}

async function removeProjectionMarkers(worktreePath: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(worktreePath);
  } catch {
    return;
  }
  await Promise.allSettled(
    entries
      .filter((entry) => /^\.tanstack-projected-[a-f0-9]+$/.test(entry))
      .map((entry) => unlink(`${worktreePath}/${entry}`))
  );
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, DEFAULT_MAX_TURNS)
    : fallback;
}

function sessionIdFrom(
  chunk: StreamChunk,
  sessionEvent: string
): string | undefined {
  if (chunk.type !== EventType.CUSTOM || chunk.name !== sessionEvent) {
    return undefined;
  }
  const value = chunk.value;
  if (typeof value !== "object" || value === null) return undefined;
  const sessionId = (value as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" ? sessionId : undefined;
}

async function* trackSession(
  stream: AsyncIterable<StreamChunk>,
  threadId: string,
  selection: HarnessSelection,
  worktreeId: string,
  worktreePath: string,
  hadProviderSession: boolean,
  abortSignal: AbortSignal | undefined,
  abortController: AbortController,
  transcriptUserPrompt?: string
): AsyncIterable<StreamChunk> {
  const abort = () => abortController.abort(abortSignal?.reason);
  abortSignal?.addEventListener("abort", abort, { once: true });
  let capturedSessionId: string | undefined;
  const assistantMessages = new AssistantMessageAccumulator();

  try {
    for await (const chunk of stream) {
      assistantMessages.observe(chunk);
      const sessionId = sessionIdFrom(chunk, selection.sessionEvent);
      if (sessionId) {
        capturedSessionId = sessionId;
        await harnessThreadStore.recordSession(
          threadId,
          selection.provider,
          sessionId,
          worktreeId
        );
      }
      if (chunk.type === EventType.RUN_FINISHED) {
        if (transcriptUserPrompt !== undefined) {
          await harnessThreadStore.recordTurn(
            threadId,
            transcriptUserPrompt,
            assistantMessages.terminalText(),
            worktreeId
          );
        }
      }
      yield chunk;
    }
  } catch (error) {
    throw error;
  } finally {
    await removeProjectionMarkers(worktreePath);
    abortSignal?.removeEventListener("abort", abort);
    if (
      !capturedSessionId &&
      !hadProviderSession &&
      (await harnessThreadStore.deleteIfUninitialized(threadId, worktreeId))
    ) {
      removeWorktree(worktreeId);
    }
  }
}

/**
 * A native harness session already contains its earlier turns. Replay the
 * provider-neutral transcript only when a provider has no resumable session,
 * such as the first turn after switching harnesses.
 */
export function messagesForHarnessSession(
  current: AguiChatParams["messages"],
  transcript: HarnessTranscriptMessage[],
  sessionId: string | undefined
): AguiChatParams["messages"] {
  return sessionId ? current : [...transcript, ...current];
}

/**
 * Run one AG-UI request through a selected TanStack coding harness. This is an
 * opt-in spike: sessions are still process-local and worktree state remains on
 * local disk. Those are the explicit seams for the later Postgres milestone.
 */
export async function runAguiChat(
  params: AguiChatParams,
  requestSignal?: AbortSignal,
  options: AguiRuntimeOptions = {}
): Promise<AsyncIterable<StreamChunk>> {
  const thread = await harnessThreadStore.getOrCreate(params.threadId, () =>
    crypto.randomUUID()
  );
  const messagesWithTranscript = options.transcriptUserPrompt
    ? [...thread.transcript, ...params.messages]
    : params.messages;
  const selection = resolveHarnessSelection(
    params.forwardedProps,
    messagesWithTranscript
  );
  const worktreeId = thread.worktreeId;
  const sessionId = resumableHarnessSession(thread, selection.provider);
  const effectiveParams: AguiChatParams = options.transcriptUserPrompt
    ? {
        ...params,
        messages: messagesForHarnessSession(
          params.messages,
          thread.transcript,
          sessionId
        ),
      }
    : params;
  const worktreePath = createWorktree(worktreeId);
  const maxTurns = positiveInteger(
    effectiveParams.forwardedProps.maxTurns,
    DEFAULT_MAX_TURNS
  );
  const model = selection.model;
  console.log(
    `[ag-ui] run=${params.runId} provider=${selection.provider} model=${model} resumed=${sessionId !== undefined}`
  );
  const abortController = new AbortController();
  if (requestSignal?.aborted) abortController.abort(requestSignal.reason);
  const clients = await buildTanStackMcpClients().catch(async (error) => {
    if (
      await harnessThreadStore.deleteIfUninitialized(
        params.threadId,
        worktreeId
      )
    ) {
      removeWorktree(worktreeId);
    }
    throw error;
  });

  const sandbox = createHarnessSandbox(worktreeId, worktreePath);

  let stream: AsyncIterable<StreamChunk>;
  try {
    stream = createHarnessStream({
      selection,
      params: effectiveParams,
      sessionId,
      worktreePath,
      worktreeId,
      maxTurns,
      clients,
      sandbox,
      abortController,
      systemPrompt:
        options.systemPrompt?.(worktreePath) ?? getBaseSystemPrompt(worktreePath),
    });
  } catch (error) {
    await Promise.allSettled(clients.map((client) => client.close()));
    if (
      await harnessThreadStore.deleteIfUninitialized(
        params.threadId,
        worktreeId
      )
    ) {
      removeWorktree(worktreeId);
    }
    throw error;
  }

  return trackSession(
    stream,
    params.threadId,
    selection,
    worktreeId,
    worktreePath,
    sessionId !== undefined,
    requestSignal,
    abortController,
    options.transcriptUserPrompt === undefined
      ? undefined
      : cleanFableControlText(options.transcriptUserPrompt)
  );
}

/** Release process-local thread state and its worktree for one-shot callers. */
export async function releaseAguiThread(threadId: string): Promise<void> {
  const state = await harnessThreadStore.delete(threadId);
  if (state) removeWorktree(state.worktreeId);
}
