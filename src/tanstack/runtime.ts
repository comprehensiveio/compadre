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
  harnessRunCapacity,
  harnessThreadRuns,
  BackgroundCapacityPreemptedError,
  type RunCapacityPriority,
  type ThreadRunLease,
} from "./thread-lock.js";
import { harnessPreparedWorktrees } from "./prepared-worktrees.js";
import {
  createAgentProcessSupervisor,
  type AgentProcessSupervisor,
} from "./process-supervisor.js";
import { superviseSandboxProvider } from "./supervised-provider.js";

export interface AguiRuntimeOptions {
  systemPrompt?: (worktreePath: string) => string;
  transcriptUserMessage?: string;
  capacityPriority?: RunCapacityPriority;
}

/**
 * Build the provider-neutral workspace boundary shared by every coding
 * harness. The comp repo's setup script is intentionally idempotent and also
 * remains wired to Claude's SessionStart hook for non-Compadre callers.
 */
export function createHarnessSandbox(
  worktreeId: string,
  worktreePath: string,
  processSupervisor?: AgentProcessSupervisor,
) {
  const localProvider = localProcessSandbox({
    dir: worktreePath,
    removeOnDestroy: false,
  });
  return defineSandbox({
    id: `compadre-agui-${worktreeId}`,
    provider: processSupervisor
      ? superviseSandboxProvider(localProvider, (pid) =>
          processSupervisor.trackRoot(pid),
        )
      : localProvider,
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
  transcriptUserMessage: string | undefined
): AsyncIterable<StreamChunk> {
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
    await removeProjectionMarkers(worktreePath);
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
 * Run one AG-UI request through a selected TanStack coding harness. Sessions
 * remain process-local and worktree state remains on local disk; those are the
 * explicit seams for the later Postgres milestone.
 */
export async function runAguiChat(
  params: AguiChatParams,
  requestSignal?: AbortSignal,
  options: AguiRuntimeOptions = {}
): Promise<AsyncIterable<StreamChunk>> {
  const threadLease = await harnessThreadRuns.acquire(params.threadId);
  let capacityLease: ThreadRunLease | undefined;
  try {
    capacityLease =
      options.capacityPriority === "background"
        ? await harnessRunCapacity.acquireBackground()
        : await harnessRunCapacity.acquireForeground();
    if (!capacityLease) throw new BackgroundCapacityPreemptedError();
    return await prepareAguiChat(params, requestSignal, options, [
      capacityLease,
      threadLease,
    ]);
  } catch (error) {
    await Promise.allSettled([
      capacityLease?.release(),
      threadLease.release(),
    ]);
    harnessPreparedWorktrees.scheduleRefill();
    throw error;
  }
}

async function prepareAguiChat(
  params: AguiChatParams,
  requestSignal: AbortSignal | undefined,
  options: AguiRuntimeOptions,
  runLeases: ThreadRunLease[]
): Promise<AsyncIterable<StreamChunk>> {
  const abortController = new AbortController();
  const abortSources = [
    ...(requestSignal ? [requestSignal] : []),
    ...runLeases.map((lease) => lease.signal),
  ];
  const abortListeners = abortSources.map((signal) => {
    const listener = () => abortController.abort(signal.reason);
    if (signal.aborted) listener();
    else signal.addEventListener("abort", listener, { once: true });
    return { signal, listener };
  });
  const removeAbortListeners = () => {
    for (const { signal, listener } of abortListeners) {
      signal.removeEventListener("abort", listener);
    }
  };
  if (abortController.signal.aborted) {
    removeAbortListeners();
    throw abortController.signal.reason;
  }

  const preparationStartedAt = Date.now();
  let worktreeSource: "existing" | "prepared" | "on-demand" = "existing";
  const thread = await harnessThreadStore.getOrCreate(
    params.threadId,
    () => {
      const prepared = harnessPreparedWorktrees.claim();
      if (prepared) {
        worktreeSource = "prepared";
        return prepared.id;
      }
      worktreeSource = "on-demand";
      return crypto.randomUUID();
    },
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
  console.log(
    `[ag-ui] run=${params.runId} worktree=${worktreeId} source=${worktreeSource} allocation=${Date.now() - preparationStartedAt}ms`,
  );
  const maxTurns = boundedMaxTurns(effectiveParams.forwardedProps.maxTurns);
  const model = selection.model;
  console.log(
    `[ag-ui] run=${params.runId} provider=${selection.provider} model=${model} resumed=${sessionId !== undefined}`
  );
  const mcpStartedAt = Date.now();
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
  console.log(
    `[ag-ui] run=${params.runId} mcp-ready=${Date.now() - mcpStartedAt}ms clients=${clients.length}`,
  );
  if (abortController.signal.aborted) {
    removeAbortListeners();
    await Promise.allSettled(clients.map((client) => client.close()));
    if (
      await harnessThreadStore.deleteIfUninitialized(
        params.threadId,
        worktreeId
      )
    ) {
      removeWorktree(worktreeId);
    }
    throw abortController.signal.reason;
  }

  const processSupervisor = createAgentProcessSupervisor(
    params.runId,
    abortController,
  );
  const sandbox = createHarnessSandbox(
    worktreeId,
    worktreePath,
    processSupervisor,
  );

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
    processSupervisor.stop();
    removeAbortListeners();
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

  const supervised = processSupervisor.guard(stream, model);
  const tracked = trackSession(
    supervised,
    params.threadId,
    selection,
    worktreeId,
    worktreePath,
    sessionId !== undefined,
    tracksTranscript ? transcriptUserMessage : undefined
  );
  return (async function* () {
    let firstEvent = true;
    try {
      for await (const chunk of tracked) {
        if (firstEvent) {
          firstEvent = false;
          console.log(
            `[ag-ui] run=${params.runId} first-event=${Date.now() - preparationStartedAt}ms`,
          );
        }
        yield chunk;
      }
    } finally {
      processSupervisor.stop();
      removeAbortListeners();
      await Promise.allSettled(clients.map((client) => client.close()));
      await Promise.allSettled(runLeases.map((lease) => lease.release()));
      harnessPreparedWorktrees.scheduleRefill();
    }
  })();
}

/** Release process-local thread state and its worktree for one-shot callers. */
export async function releaseAguiThread(threadId: string): Promise<void> {
  const state = await harnessThreadStore.delete(threadId);
  if (state) removeWorktree(state.worktreeId);
}
