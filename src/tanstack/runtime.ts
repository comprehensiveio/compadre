import crypto from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import { EventType, type StreamChunk } from "@tanstack/ai";
import {
  defineSandbox,
  defineWorkspace,
} from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import { getBaseSystemPrompt } from "../prompts/index.js";
import { createWorktree, removeWorktree } from "../repo.js";
import {
  createHarnessStream,
  resolveHarnessSelection,
  type HarnessSelection,
} from "./harness.js";
import { buildTanStackMcpClients } from "./mcp.js";
import { AssistantMessageAccumulator } from "./assistant-messages.js";
import {
  boundedMaxTurns,
  sessionIdFromChunk,
  type AguiChatParams,
} from "./protocol.js";
import {
  harnessThreadStore,
  resumableHarnessSession,
  type HarnessTranscriptMessage,
} from "./thread-state.js";
import {
  harnessThreadRuns,
  type ThreadRunLease,
} from "./thread-lock.js";

export interface AguiRuntimeOptions {
  systemPrompt?: (worktreePath: string) => string;
  transcriptUserMessage?: string;
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
    // watcher to avoid duplicate events and watcher overhead.
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

async function* trackSession(
  stream: AsyncIterable<StreamChunk>,
  threadId: string,
  selection: HarnessSelection,
  worktreeId: string,
  worktreePath: string,
  hadProviderSession: boolean,
  abortSignal: AbortSignal | undefined,
  abortController: AbortController,
  transcriptUserMessage: string | undefined,
  runLease: ThreadRunLease
): AsyncIterable<StreamChunk> {
  const abort = () => abortController.abort(abortSignal?.reason);
  abortSignal?.addEventListener("abort", abort, { once: true });
  let capturedSessionId: string | undefined;
  const assistantMessages = new AssistantMessageAccumulator();

  try {
    for await (const chunk of stream) {
      assistantMessages.observe(chunk);
      const sessionId = sessionIdFromChunk(chunk, selection.provider);
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
        if (transcriptUserMessage !== undefined) {
          await harnessThreadStore.recordTurn(
            threadId,
            transcriptUserMessage,
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
    try {
      await removeProjectionMarkers(worktreePath);
      abortSignal?.removeEventListener("abort", abort);
      if (
        !capturedSessionId &&
        !hadProviderSession &&
        (await harnessThreadStore.deleteIfUninitialized(threadId, worktreeId))
      ) {
        removeWorktree(worktreeId);
      }
    } finally {
      await runLease.release();
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
 * Run one AG-UI request through a selected TanStack coding harness. Sessions
 * remain process-local and worktree state remains on local disk; those are the
 * explicit seams for the later Postgres milestone.
 */
export async function runAguiChat(
  params: AguiChatParams,
  requestSignal?: AbortSignal,
  options: AguiRuntimeOptions = {}
): Promise<AsyncIterable<StreamChunk>> {
  const runLease = await harnessThreadRuns.acquire(params.threadId);
  try {
    return await prepareAguiChat(params, requestSignal, options, runLease);
  } catch (error) {
    await runLease.release();
    throw error;
  }
}

async function prepareAguiChat(
  params: AguiChatParams,
  requestSignal: AbortSignal | undefined,
  options: AguiRuntimeOptions,
  runLease: ThreadRunLease
): Promise<AsyncIterable<StreamChunk>> {
  const thread = await harnessThreadStore.getOrCreate(params.threadId, () =>
    crypto.randomUUID()
  );
  const transcriptUserMessage = options.transcriptUserMessage;
  const tracksTranscript = transcriptUserMessage !== undefined;
  const selection = resolveHarnessSelection(params.forwardedProps);
  const worktreeId = thread.worktreeId;
  const sessionId = resumableHarnessSession(thread, selection.provider);
  const effectiveParams: AguiChatParams = tracksTranscript
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
  const maxTurns = boundedMaxTurns(effectiveParams.forwardedProps.maxTurns);
  const model = selection.model;
  console.log(
    `[ag-ui] run=${params.runId} provider=${selection.provider} model=${model} resumed=${sessionId !== undefined}`
  );
  const abortController = new AbortController();
  if (requestSignal?.aborted) abortController.abort(requestSignal.reason);
  const abortForLostLease = () => abortController.abort(runLease.signal.reason);
  runLease.signal.addEventListener("abort", abortForLostLease, { once: true });
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

  const tracked = trackSession(
    stream,
    params.threadId,
    selection,
    worktreeId,
    worktreePath,
    sessionId !== undefined,
    requestSignal,
    abortController,
    tracksTranscript ? transcriptUserMessage : undefined,
    runLease
  );
  return (async function* () {
    try {
      yield* tracked;
    } finally {
      runLease.signal.removeEventListener("abort", abortForLostLease);
    }
  })();
}

/** Release process-local thread state and its worktree for one-shot callers. */
export async function releaseAguiThread(threadId: string): Promise<void> {
  const state = await harnessThreadStore.delete(threadId);
  if (state) removeWorktree(state.worktreeId);
}
