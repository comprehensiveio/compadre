import crypto from "node:crypto";
import {
  EventType,
  convertMessagesToModelMessages,
  type ModelMessage,
  type StreamChunk,
} from "@tanstack/ai";
import { getBaseSystemPrompt } from "../prompts/index.js";
import { createChannelConversationPersistence } from "../persistence/conversation.js";
import {
  getConfiguredThreadPersistence,
  getRequiredThreadPersistence,
} from "../persistence/runtime.js";
import {
  materializeSlackFiles,
  type SlackFileReference,
} from "../services/slack-files.js";
import {
  createHarnessStream,
  resolveHarnessSelection,
  type HarnessSelection,
} from "./harness.js";
import { buildTanStackMcpClients } from "./mcp.js";
import { AssistantMessageAccumulator } from "./assistant-messages.js";
import {
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
  ThreadRunCoordinator,
  type RunCapacityPriority,
  type ThreadRunLease,
} from "./thread-lock.js";
import {
  createHarnessSandbox,
  harnessWorkspacePath,
} from "./sandbox-runtime.js";

export { createHarnessSandbox } from "./sandbox-runtime.js";
import {
  HarnessRunTelemetry,
  type WorktreeSource,
} from "./runtime-telemetry.js";

export interface AguiRuntimeOptions {
  systemPrompt?: (worktreePath: string) => string;
  transcriptUserMessage?: string;
  capacityPriority?: RunCapacityPriority;
  /** False only for generated one-off threads; true requires durability. */
  persistThread?: boolean;
  slackFiles?: SlackFileReference[];
}

export function shouldReuseThreadSandbox(
  threadPersistence: Awaited<ReturnType<typeof getConfiguredThreadPersistence>>,
): boolean {
  return threadPersistence !== null;
}

function latestUserInput(
  messages: AguiChatParams["messages"],
): unknown | undefined {
  const normalized = convertMessagesToModelMessages(messages);
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const message = normalized[index];
    if (message?.role === "user") return message.content;
  }
  return undefined;
}

interface ActiveRunLeases {
  thread: ThreadRunLease;
}

async function* trackSession(
  stream: AsyncIterable<StreamChunk>,
  threadId: string,
  selection: HarnessSelection,
  worktreeId: string,
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
    if (!capturedSessionId && !hadProviderSession) {
      await harnessThreadStore.deleteIfUninitialized(threadId, worktreeId);
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

export function messagesWithAttachmentPrompt(
  messages: AguiChatParams["messages"],
  attachmentPrompt: string,
): AguiChatParams["messages"] {
  if (!attachmentPrompt) return messages;
  const normalized = convertMessagesToModelMessages(messages) as ModelMessage[];
  let index = -1;
  for (let candidate = normalized.length - 1; candidate >= 0; candidate -= 1) {
    if (normalized[candidate]?.role === "user") {
      index = candidate;
      break;
    }
  }
  if (index === -1) return messages;
  const message = normalized[index]!;
  const suffix = `\n\n${attachmentPrompt}`;
  normalized[index] = {
    ...message,
    content:
      typeof message.content === "string"
        ? `${message.content}${suffix}`
        : [
            ...(message.content ?? []),
            { type: "text", content: suffix },
          ],
  };
  return normalized;
}

async function discardPreparation(
  threadId: string,
  worktreeId: string,
  clients: ReadonlyArray<{ close(): Promise<void> }> = [],
): Promise<void> {
  await Promise.allSettled(clients.map((client) => client.close()));
  await harnessThreadStore.deleteIfUninitialized(threadId, worktreeId);
}

/**
 * Run one AG-UI request through a selected TanStack coding harness. Sessions
 * serialize per thread while independent Daytona workspaces run concurrently.
 */
export async function runAguiChat(
  params: AguiChatParams,
  requestSignal?: AbortSignal,
  options: AguiRuntimeOptions = {}
): Promise<AsyncIterable<StreamChunk>> {
  const threadPersistence = options.persistThread === false
    ? null
    : options.persistThread === true
      ? await getRequiredThreadPersistence()
      : await getConfiguredThreadPersistence();
  const selection = resolveHarnessSelection(params.forwardedProps);
  const telemetry = new HarnessRunTelemetry({
    selection,
    threadId: params.threadId,
    runId: params.runId,
    input: latestUserInput(params.messages),
  });
  let threadLease: ThreadRunLease | undefined;
  try {
    threadLease = await telemetry.phase("queue.thread", () =>
      threadPersistence
        ? new ThreadRunCoordinator(threadPersistence.locks).acquire(
            params.threadId,
          )
        : harnessThreadRuns.acquire(params.threadId),
    );
    return await prepareAguiChat(
      params,
      requestSignal,
      options,
      { thread: threadLease },
      selection,
      telemetry,
      threadPersistence,
    );
  } catch (error) {
    await Promise.allSettled([threadLease?.release()]);
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
  threadPersistence: Awaited<ReturnType<typeof getConfiguredThreadPersistence>>,
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
  const worktreeSource: WorktreeSource = "existing";
  const allocation = await telemetry.phase("worktree.allocate", async () => {
    const thread = await harnessThreadStore.getOrCreate(
      params.threadId,
      () => crypto.createHash("sha256").update(params.threadId).digest("hex").slice(0, 32),
    );
    const worktreeId = thread.worktreeId;
    telemetry.setWorktree(worktreeId, worktreeSource);
    const worktreePath = harnessWorkspacePath("/unused");
    return { thread, worktreeId, worktreePath };
  });
  const { thread, worktreeId, worktreePath } = allocation;
  const remoteAttachmentDirectory = `${harnessWorkspacePath(worktreePath)}/.compadre-attachments-${worktreeId}`;
  const attachments = await materializeSlackFiles(options.slackFiles ?? [], {
    promptDirectory: remoteAttachmentDirectory,
  });
  const inputParams = attachments.prompt
    ? {
        ...params,
        messages: messagesWithAttachmentPrompt(
          params.messages,
          attachments.prompt,
        ),
      }
    : params;
  const transcriptUserMessage = options.transcriptUserMessage;
  const tracksTranscript = transcriptUserMessage !== undefined;
  const sessionId = resumableHarnessSession(thread, selection.provider);
  let persistence = threadPersistence?.persistence;
  let effectiveParams: AguiChatParams;
  try {
    if (persistence && tracksTranscript) {
      const providerMessages = convertMessagesToModelMessages(
        inputParams.messages,
      ) as ModelMessage[];
      persistence = await createChannelConversationPersistence(persistence, {
        threadId: params.threadId,
        providerMessages,
        transcriptUserMessage,
        resumesNativeSession: sessionId !== undefined,
      });
      effectiveParams = { ...inputParams, messages: [] };
    } else if (tracksTranscript) {
      effectiveParams = {
        ...inputParams,
        messages: messagesForHarnessSession(
          inputParams.messages,
          thread.transcript,
          sessionId,
        ),
      };
    } else {
      effectiveParams = inputParams;
    }
  } catch (error) {
    await attachments.cleanup();
    throw error;
  }
  console.log(
    `[ag-ui] run=${params.runId} worktree=${worktreeId} source=${worktreeSource} allocation=${Date.now() - preparationStartedAt}ms`,
  );
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
    await attachments.cleanup();
    await discardPreparation(params.threadId, worktreeId);
    throw error;
  }
  console.log(
    `[ag-ui] run=${params.runId} mcp-ready=${Date.now() - mcpStartedAt}ms clients=${clients.length}`,
  );
  if (abortController.signal.aborted) {
    removeAbortListeners();
    await attachments.cleanup();
    await discardPreparation(params.threadId, worktreeId, clients);
    throw abortController.signal.reason;
  }

  const harnessWorktreePath = harnessWorkspacePath(worktreePath);
  const sandbox = createHarnessSandbox({
    worktreeId,
    localWorktreePath: worktreePath,
    uploads: attachments.uploads,
    reuseThread: shouldReuseThreadSandbox(threadPersistence),
  });

  let stream: AsyncIterable<StreamChunk>;
  try {
    stream = await telemetry.phase("stream.initialize", async () =>
      createHarnessStream({
        selection,
        params: effectiveParams,
        sessionId,
        worktreePath: harnessWorktreePath,
        worktreeId,
        clients,
        sandbox,
        abortController,
        systemPrompt:
          options.systemPrompt?.(harnessWorktreePath) ??
          getBaseSystemPrompt(harnessWorktreePath),
        persistence,
        locks: threadPersistence?.locks,
        sandboxInstances: threadPersistence?.sandboxInstances,
      }),
    );
  } catch (error) {
    removeAbortListeners();
    await attachments.cleanup();
    await discardPreparation(params.threadId, worktreeId, clients);
    throw error;
  }

  const tracked = trackSession(
    stream,
    params.threadId,
    selection,
    worktreeId,
    sessionId !== undefined,
    tracksTranscript && !persistence ? transcriptUserMessage : undefined
  );
  return (async function* () {
    let firstEvent = true;
    let failure: unknown;
    const iterator = tracked[Symbol.asyncIterator]();
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
      removeAbortListeners();
      await attachments.cleanup();
      await Promise.allSettled(clients.map((client) => client.close()));
      await Promise.allSettled(
        Object.values(runLeases).map((lease) => lease.release()),
      );
      telemetry.end(failure);
    }
  })();
}

/** Release process-local transcript/session state for one-shot callers. */
export async function releaseAguiThread(threadId: string): Promise<void> {
  await harnessThreadStore.delete(threadId);
}
