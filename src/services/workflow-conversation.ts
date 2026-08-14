import crypto from "node:crypto";
import { replayRunStream } from "@tanstack/ai";
import type {
  ConversationOptions,
  ConversationResult,
} from "../conversation.js";
import { configuredAgentProvider } from "../conversation.js";
import {
  failOpenDurableRun,
  getConfiguredAgentRunDurability,
} from "../durability/runtime.js";
import {
  consumeHarnessConversation,
} from "../tanstack/conversation.js";
import { providerForAgentProfile } from "../tanstack/protocol.js";
import {
  createConfiguredWorkflowRunLauncher,
  type WorkflowRunLauncher,
} from "./workflow-run-launcher.js";

export interface WorkflowConversationDependencies {
  getDurability: typeof getConfiguredAgentRunDurability;
  getLauncher(): WorkflowRunLauncher;
  createId(): string;
  now(): number;
}

let configuredLauncher: WorkflowRunLauncher | undefined;
const defaultDependencies: WorkflowConversationDependencies = {
  getDurability: getConfiguredAgentRunDurability,
  getLauncher: () =>
    (configuredLauncher ??= createConfiguredWorkflowRunLauncher()),
  createId: () => crypto.randomUUID(),
  now: Date.now,
};

/**
 * Launch an ephemeral Workflow producer and consume its Postgres-backed AG-UI
 * log as the same channel-neutral conversation stream used by the old server.
 */
export async function runWorkflowConversation(
  options: ConversationOptions,
  dependencies: WorkflowConversationDependencies = defaultDependencies,
): Promise<ConversationResult> {
  const durability = await dependencies.getDurability();
  if (!durability) {
    throw new Error("Workflow conversations require agent run durability");
  }
  const runId = options.runId ?? dependencies.createId();
  const threadId = options.threadId ?? `workflow-${runId}`;
  const provider = options.profile
    ? providerForAgentProfile(options.profile)
    : options.provider ?? configuredAgentProvider();
  const startedAt = dependencies.now();
  const stream = durability.stream(runId);
  const launcher = dependencies.getLauncher();
  await durability.runs.createOrResume({
    runId,
    threadId,
    startedAt,
  });
  let task: Awaited<ReturnType<WorkflowRunLauncher["start"]>>;
  try {
    task = await launcher.start({
      runId,
      threadId,
      prompt: options.prompt,
      transcriptUserMessage:
        options.transcriptUserMessage ?? options.prompt,
      provider: options.provider,
      profile: options.profile,
      responseMode: options.stream ? "slack-streaming" : "default",
      persistThread: options.persistThread ?? options.threadId !== undefined,
    });
  } catch (error) {
    try {
      await failOpenDurableRun(durability, runId, error, dependencies.now);
    } catch (finalizationError) {
      console.error("[workflow-relay] failure finalization failed", {
        runId,
        error: finalizationError,
      });
    }
    throw error;
  }

  const abortController = new AbortController();
  const abort = () => abortController.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();

  const consumption = consumeHarnessConversation(
    replayRunStream(stream, "-1", abortController.signal),
    { runId, provider, startedAt, stream: options.stream },
  );
  const monitoredFailure = launcher.wait
    ? launcher.wait(task.taskRunId, abortController.signal).then(
        () => new Promise<never>(() => undefined),
        async (error) => {
          try {
            await failOpenDurableRun(
              durability,
              runId,
              error,
              dependencies.now,
            );
          } catch (finalizationError) {
            console.error("[workflow-relay] failure finalization failed", {
              runId,
              error: finalizationError,
            });
          }
          abortController.abort(error);
          throw error;
        },
      )
    : new Promise<never>(() => undefined);

  try {
    return await Promise.race([consumption, monitoredFailure]);
  } finally {
    abortController.abort();
    options.signal?.removeEventListener("abort", abort);
    void consumption.catch(() => undefined);
  }
}
