import crypto from "node:crypto";
import { log, serializeError } from "../logging.js";
import { getConfiguredThreadPersistence } from "../persistence/runtime.js";
import { HostedThreadBindingStore } from "../services/hosted-thread-bindings.js";
import { SlackClient } from "../services/slack-client.js";
import {
  finalAssistantTextForDispatch,
  t3ModelSelectionForProfile,
  t3SlackDetailsMarkdown,
} from "../services/t3-slack-conversation.js";
import {
  CENTRAL_T3_TIMEOUT_MS,
  centralT3AbsoluteTimeoutMs,
  centralT3DetailsUrl,
  centralT3ThreadId,
  configuredCentralT3Client,
  runCentralT3Conversation,
  type CentralT3ConversationClient,
} from "../t3/central-conversation.js";
import type { T3Client, T3MessageAttribution } from "../t3/client.js";
import type {
  TriggeredPromptDeliveryResult,
  TriggeredPromptRecord,
} from "./types.js";

/**
 * Delivery layer for triggered prompts — the single entry point every trigger
 * source (cron today, others later) uses to hand a prompt to the agent.
 *
 * The turn is dispatched straight to central T3 with per-message origin
 * "trigger" attribution; the web UI renders that attribution in place of a
 * user and the agent receives only the prompt text — nothing about the
 * trigger. Only the agent's answer ever reaches Slack: trigger turns are
 * excluded from the native "From Compadre web" mirror (which would post the
 * prompt), so this module owns their Slack delivery end to end.
 *
 * Fire-and-forget beyond dispatch — the turn completes (and the answer posts)
 * asynchronously; the poster is tracked so shutdown drains it, and failures
 * notify the Slack thread when one exists.
 */

const FAILURE_NOTICE =
  "The scheduled prompt could not be completed. The failure was recorded for investigation.";

export interface TriggeredPromptSlack {
  postMessage(
    channel: string,
    markdown: string,
  ): Promise<{ ts?: unknown } & Record<string, unknown>>;
  replyToThread(
    channel: string,
    threadTs: string,
    markdown: string,
  ): Promise<Record<string, unknown>>;
  postContext(
    channel: string,
    markdown: string,
    threadTs?: string,
  ): Promise<Record<string, unknown>>;
}

export interface TriggeredPromptBindings {
  slack(
    threadId: string,
  ): Promise<{
    channelId: string;
    threadTs: string;
    recipientTeamId?: string;
  } | null>;
  bindSlack(
    threadId: string,
    binding: {
      channelId: string;
      threadTs: string;
      recipientTeamId?: string;
      t3EnvironmentId?: string;
      t3ThreadId?: string;
    },
  ): Promise<void>;
  bindAlias(aliasThreadId: string, canonicalThreadId: string): Promise<void>;
}

export interface TriggeredPromptDeliveryDependencies {
  client: CentralT3ConversationClient & Pick<T3Client, "baseUrl">;
  slack: TriggeredPromptSlack | null;
  bindings: TriggeredPromptBindings;
  workspaceId?: string;
  idFactory?: () => string;
}

async function defaultDependencies(): Promise<TriggeredPromptDeliveryDependencies> {
  const client = configuredCentralT3Client();
  if (!client) {
    throw new Error(
      "Triggered prompts require COMPADRE_T3_CENTRAL_URL and COMPADRE_T3_CENTRAL_TOKEN.",
    );
  }
  const runtime = await getConfiguredThreadPersistence();
  if (!runtime) {
    throw new Error("Triggered prompts require configured thread persistence.");
  }
  const botToken = process.env.SLACK_BOT_TOKEN?.trim();
  const workspaceId = process.env.COMPADRE_SLACK_WORKSPACE_ID?.trim();
  return {
    client,
    slack:
      botToken && workspaceId
        ? new SlackClient({ botToken, teamId: workspaceId })
        : null,
    bindings: new HostedThreadBindingStore(runtime.persistence.stores.metadata),
    ...(workspaceId ? { workspaceId } : {}),
  };
}

/** In-flight answer posters, drained on shutdown. */
const active = new Set<Promise<void>>();

export function drainTriggeredPromptDeliveries(): Promise<unknown> {
  return Promise.allSettled([...active]);
}

function triggerAttribution(record: TriggeredPromptRecord): T3MessageAttribution {
  return {
    userId: `trigger:${record.id}`,
    displayName: record.name,
    origin: "trigger",
    trigger: {
      triggerId: record.id,
      name: record.name,
      triggerType: record.triggerType,
      cronExpression: record.triggerConfig.cronExpression,
      ...(record.triggerConfig.timezone
        ? { timezone: record.triggerConfig.timezone }
        : {}),
    },
  };
}

export async function deliverTriggeredPrompt(
  record: TriggeredPromptRecord,
  dependencies?: TriggeredPromptDeliveryDependencies,
): Promise<TriggeredPromptDeliveryResult> {
  const deps = dependencies ?? (await defaultDependencies());
  const idFactory = deps.idFactory ?? crypto.randomUUID;
  const attribution = triggerAttribution(record);
  const messageId = `trigger:${record.id}:${idFactory()}`;

  const deliverAnswer = (
    run: () => Promise<void>,
    failureDestination?: { channelId: string; threadTs: string },
  ) => {
    const task = run()
      .catch(async (error) => {
        log.error(
          { triggerId: record.id, ...serializeError(error) },
          "triggered prompt turn failed",
        );
        if (failureDestination && deps.slack) {
          await deps.slack
            .replyToThread(
              failureDestination.channelId,
              failureDestination.threadTs,
              FAILURE_NOTICE,
            )
            .catch(() => undefined);
        }
      })
      .finally(() => active.delete(task));
    active.add(task);
  };

  const postAnswer = async (
    channelId: string,
    threadTs: string,
    output: string,
    detailsUrl: string,
  ) => {
    if (!deps.slack) return;
    await deps.slack.replyToThread(channelId, threadTs, output);
    await deps.slack.postContext(
      channelId,
      t3SlackDetailsMarkdown(detailsUrl),
      threadTs,
    );
  };

  // Explicit central thread target (existing_thread delivery).
  if (record.deliveryMode === "existing_thread") {
    const centralThreadId = record.targetThreadId;
    if (!centralThreadId) {
      throw new Error(`Triggered prompt ${record.id} has no target thread`);
    }
    const binding = await deps.bindings.slack(centralThreadId);
    if (
      binding?.recipientTeamId &&
      deps.workspaceId &&
      binding.recipientTeamId !== deps.workspaceId
    ) {
      throw new Error(
        `Refused triggered prompt for foreign workspace ${binding.recipientTeamId}`,
      );
    }
    const [descriptor, orchestration] = await Promise.all([
      deps.client.environmentDescriptor(),
      deps.client.snapshot(),
    ]);
    const thread = orchestration.threads.find(
      (candidate) => candidate.id === centralThreadId,
    );
    if (!thread) {
      throw new Error(`Central T3 thread ${centralThreadId} was not found`);
    }
    const dispatch = await deps.client.startTurn({
      threadId: centralThreadId,
      messageId,
      text: record.prompt,
      attribution,
      modelSelection:
        thread.modelSelection ?? t3ModelSelectionForProfile(undefined),
    });
    deliverAnswer(async () => {
      const snapshot = await deps.client.waitForTurnTerminal({
        threadId: centralThreadId,
        minimumSequence: dispatch.sequence,
        messageId: dispatch.messageId,
        requestedAt: dispatch.createdAt,
        timeoutMs: CENTRAL_T3_TIMEOUT_MS,
        absoluteTimeoutMs: centralT3AbsoluteTimeoutMs(),
      });
      const state = snapshot.thread.latestTurn?.state;
      if (state === "error" || state === "interrupted") {
        throw new Error(
          snapshot.thread.session?.lastError || `The central T3 run ${state}`,
        );
      }
      const output = finalAssistantTextForDispatch(snapshot, dispatch);
      if (!output) {
        throw new Error(
          "The central T3 run completed without an assistant response",
        );
      }
      if (binding) {
        const detailsUrl = centralT3DetailsUrl({
          baseUrl: deps.client.baseUrl,
          environmentId: descriptor.environmentId,
          threadId: centralThreadId,
        });
        await postAnswer(binding.channelId, binding.threadTs, output, detailsUrl);
      }
    }, binding ?? undefined);
    log.info(
      { triggerId: record.id, centralThreadId, delivery: record.deliveryMode },
      "triggered prompt dispatched",
    );
    return { centralThreadId, delivery: record.deliveryMode };
  }

  // Slack-channel modes: new_thread (fresh conversation per fire) or
  // same_thread (a stable conversation key pins one central thread, and the
  // first answer's Slack root anchors where later answers reply).
  const channelId = record.slackChannelId;
  if (!channelId) {
    throw new Error(
      "Triggered prompt has neither a Slack channel nor a target thread",
    );
  }
  const canonicalThreadId =
    record.deliveryMode === "same_thread" ? `trigger:${record.id}` : messageId;
  const centralThreadId = centralT3ThreadId(canonicalThreadId);
  const existingAnswerThread = await deps.bindings.slack(centralThreadId);
  deliverAnswer(async () => {
    const result = await runCentralT3Conversation({
      client: deps.client,
      canonicalThreadId,
      title: record.name,
      prompt: record.prompt,
      attribution,
    });
    if (existingAnswerThread) {
      await postAnswer(
        existingAnswerThread.channelId,
        existingAnswerThread.threadTs,
        result.output,
        result.detailsUrl,
      );
      return;
    }
    if (!deps.slack) {
      log.warn(
        { triggerId: record.id, centralThreadId },
        "triggered prompt completed without Slack delivery (no bot credential)",
      );
      return;
    }
    const root = await deps.slack.postMessage(channelId, result.output);
    const rootTs = typeof root.ts === "string" ? root.ts : undefined;
    if (!rootTs) {
      throw new Error("Slack did not return a timestamp for the answer");
    }
    await deps.slack.postContext(
      channelId,
      t3SlackDetailsMarkdown(result.detailsUrl),
      rootTs,
    );
    // Later same_thread fires find this root and reply into it; the binding
    // also lets worker artifacts and blocked-destination guards target it.
    await deps.bindings.bindAlias(canonicalThreadId, result.t3ThreadId);
    await deps.bindings.bindSlack(result.t3ThreadId, {
      channelId,
      threadTs: rootTs,
      ...(deps.workspaceId ? { recipientTeamId: deps.workspaceId } : {}),
      t3EnvironmentId: result.environmentId,
      t3ThreadId: result.t3ThreadId,
    });
  }, existingAnswerThread ?? undefined);
  log.info(
    { triggerId: record.id, centralThreadId, delivery: record.deliveryMode },
    "triggered prompt dispatched",
  );
  return { centralThreadId, delivery: record.deliveryMode };
}
