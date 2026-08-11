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
import {
  HarnessRunTelemetry,
  type WorktreeSource,
} from "./runtime-telemetry.js";

export interface AguiRuntimeOptions {
  systemPrompt?: (worktreePath: string) => string;
  transcriptUserMessage?: string;
  capacityPriority?: RunCapacityPriority;
}

interface ActiveRunLeases {
  capacity: ThreadRunLease;
  thread: ThreadRunLease;
}

/** Build the provider-neutral workspace boundary shared by every harness. */
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

async function discardPreparation(
  threadId: string,
  worktreeId: string,
  clients: ReadonlyArray<{ close(): Promise<void> }> = [],
): Promise<void> {
  await Promise.allSettled(clients.map((client) => client.close()));
  if (await harnessThreadStore.deleteIfUninitialized(threadId, worktreeId)) {
    removeWorktree(worktreeId);
  }
}

function backgroundPreemptionReason(
  lease: ThreadRunLease,
): BackgroundCapacityPreemptedError | undefined {
  return lease.signal.aborted &&
    lease.signal.reason instanceof BackgroundCapacityPreemptedError
    ? lease.signal.reason
    : undefined;
}

export async function* guardBackgroundPreemption(
  stream: AsyncIterable<StreamChunk>,
  capacityLease: ThreadRunLease,
): AsyncIterable<StreamChunk> {
  let sawTerminal = false;
  try {
    for await (const chunk of stream) {
      const preemption = backgroundPreemptionReason(capacityLease);
      if (!sawTerminal && preemption) throw preemption;
      if (
        chunk.type === EventType.RUN_ERROR ||
        chunk.type === EventType.RUN_FINISHED
      ) {
        sawTerminal = true;
      }
      yield chunk;
    }
  } catch (error) {
    throw (
      (!sawTerminal && backgroundPreemptionReason(capacityLease)) ?? error
    );
  }
  const preemption = backgroundPreemptionReason(capacityLease);
  if (!sawTerminal && preemption) throw preemption;
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
  const selection = resolveHarnessSelection(params.forwardedProps);
  const telemetry = new HarnessRunTelemetry({
    selection,
    threadId: params.threadId,
    runId: params.runId,
  });
  let threadLease: ThreadRunLease | undefined;
  let capacityLease: ThreadRunLease | undefined;
  try {
    threadLease = await telemetry.phase("queue.thread", () =>
      harnessThreadRuns.acquire(params.threadId),
    );
    capacityLease =
      options.capacityPriority === "background"
        ? await telemetry.phase("queue.capacity", () =>
            harnessRunCapacity.acquireBackground(),
          )
        : await telemetry.phase("queue.capacity", () =>
            harnessRunCapacity.acquireForeground(),
          );
    if (!capacityLease) throw new BackgroundCapacityPreemptedError();
    return await prepareAguiChat(
      params,
      requestSignal,
      options,
      {
        capacity: capacityLease,
        thread: threadLease,
      },
      selection,
      telemetry,
    );
  } catch (error) {
    await Promise.allSettled([
      capacityLease?.release(),
      threadLease?.release(),
    ]);
    harnessPreparedWorktrees.scheduleRefill();
    telemetry.end(error);
    throw error;
  }
}

async function prepareAguiChat(
  params: AguiChatParams,
  requestSignal: AbortSignal | undefined,
  options: AguiRuntimeOptions,
  runLeases: ActiveRunLeases,
  selection: HarnessSelection,
  telemetry: HarnessRunTelemetry,
): Promise<AsyncIterable<StreamChunk>> {
  const abortController = new AbortController();
  const abortSources = [
    ...(requestSignal ? [requestSignal] : []),
    ...Object.values(runLeases).map((lease) => lease.signal),
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
  let worktreeSource: WorktreeSource = "existing";
  const allocation = await telemetry.phase("worktree.allocate", async () => {
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
    const worktreeId = thread.worktreeId;
    const worktreePath = createWorktree(worktreeId);
    telemetry.setWorktree(worktreeId, worktreeSource);
    return { thread, worktreeId, worktreePath };
  });
  const { thread, worktreeId, worktreePath } = allocation;
  const transcriptUserMessage = options.transcriptUserMessage;
  const tracksTranscript = transcriptUserMessage !== undefined;
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
  console.log(
    `[ag-ui] run=${params.runId} worktree=${worktreeId} source=${worktreeSource} allocation=${Date.now() - preparationStartedAt}ms`,
  );
  const maxTurns = boundedMaxTurns(effectiveParams.forwardedProps.maxTurns);
  const model = selection.model;
  console.log(
    `[ag-ui] run=${params.runId} provider=${selection.provider} model=${model} resumed=${sessionId !== undefined}`
  );
  const mcpStartedAt = Date.now();
  let clients: Awaited<ReturnType<typeof buildTanStackMcpClients>>;
  try {
    clients = await telemetry.phase("mcp.initialize", () =>
      buildTanStackMcpClients(),
    );
  } catch (error) {
    removeAbortListeners();
    await discardPreparation(params.threadId, worktreeId);
    throw backgroundPreemptionReason(runLeases.capacity) ?? error;
  }
  console.log(
    `[ag-ui] run=${params.runId} mcp-ready=${Date.now() - mcpStartedAt}ms clients=${clients.length}`,
  );
  if (abortController.signal.aborted) {
    removeAbortListeners();
    await discardPreparation(params.threadId, worktreeId, clients);
    throw abortController.signal.reason;
  }

  const processSupervisor = createAgentProcessSupervisor(
    params.runId,
    abortController,
    process.env,
    (sample) =>
      telemetry.observeMemory(
        sample.treeRssBytes,
        sample.hostUsageBytes,
        sample.hostLimitBytes,
      ),
  );
  const sandbox = createHarnessSandbox(
    worktreeId,
    worktreePath,
    processSupervisor,
  );

  let stream: AsyncIterable<StreamChunk>;
  try {
    stream = await telemetry.phase("stream.initialize", async () =>
      createHarnessStream({
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
      }),
    );
  } catch (error) {
    processSupervisor.stop();
    removeAbortListeners();
    await discardPreparation(params.threadId, worktreeId, clients);
    throw backgroundPreemptionReason(runLeases.capacity) ?? error;
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
    let failure: unknown;
    const guarded = guardBackgroundPreemption(tracked, runLeases.capacity);
    const iterator = guarded[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await telemetry.inContext(() => iterator.next());
        if (next.done) break;
        const chunk = next.value;
        telemetry.observe(chunk);
        if (firstEvent) {
          firstEvent = false;
          console.log(
            `[ag-ui] run=${params.runId} first-event=${Date.now() - preparationStartedAt}ms`,
          );
        }
        yield chunk;
      }
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        await telemetry.inContext(() => iterator.return?.());
      } catch (error) {
        failure ??= error;
      }
      processSupervisor.stop();
      removeAbortListeners();
      await Promise.allSettled(clients.map((client) => client.close()));
      await Promise.allSettled(
        Object.values(runLeases).map((lease) => lease.release()),
      );
      harnessPreparedWorktrees.scheduleRefill();
      telemetry.end(failure);
    }
  })();
}

/** Release process-local thread state and its worktree for one-shot callers. */
export async function releaseAguiThread(threadId: string): Promise<void> {
  const state = await harnessThreadStore.delete(threadId);
  if (state) removeWorktree(state.worktreeId);
}
