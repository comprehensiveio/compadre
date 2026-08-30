import crypto from "node:crypto";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  configuredCentralT3Client,
  type CentralT3ConversationClient,
} from "../t3/central-conversation.js";
import type { T3TurnDispatch } from "../t3/client.js";
import { incompleteProviderStopReason } from "../t3/client.js";
import { finalAssistantTextForDispatch } from "./t3-slack-conversation.js";
import { SlackStream } from "./slack-stream.js";
import { slackFailureNotice } from "./terminal-response.js";
import type {
  SlackTurnDelivery,
  SlackTurnDeliveryStore,
} from "./slack-turn-delivery-store.js";

const DELIVERY_WAIT_TIMEOUT_MS = 20 * 60_000;
const DELIVERY_CLAIM_HEARTBEAT_MS = 60_000;
const DELIVERY_CONCURRENCY = 4;
export const DEFAULT_SLACK_DELIVERY_INTERVAL_MS = 15_000;

export interface SlackTurnDeliveryClient {
  postThreadMessage(text: string, clientMsgId?: string): Promise<void>;
  postThreadContext(text: string, clientMsgId?: string): Promise<void>;
  clearStatus(): Promise<void>;
  markRunSucceeded(messageTs: string): Promise<void>;
  markRunFailed(messageTs: string): Promise<void>;
}

function relatedUuid(id: string, purpose: string): string {
  const bytes = crypto
    .createHash("sha256")
    .update(`${id}:${purpose}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function dispatchFor(delivery: SlackTurnDelivery): T3TurnDispatch {
  return {
    sequence: delivery.dispatchSequence,
    commandId: relatedUuid(delivery.id, "command"),
    messageId: delivery.messageId,
    threadId: delivery.t3ThreadId,
    createdAt: delivery.dispatchCreatedAt.toISOString(),
  };
}

/** Deliver one already-claimed outbox row and acknowledge it only at the end. */
export async function deliverClaimedSlackTurn(input: {
  delivery: SlackTurnDelivery;
  store: Pick<SlackTurnDeliveryStore, "markDelivered" | "markFailed"> &
    Partial<Pick<SlackTurnDeliveryStore, "renewClaim">>;
  t3: CentralT3ConversationClient;
  slack: SlackTurnDeliveryClient;
  logger?: Pick<Console, "info" | "warn" | "error">;
}): Promise<boolean> {
  const { delivery, store, t3, slack, logger = console } = input;
  const span = trace.getTracer("compadre.slack.delivery").startSpan(
    "compadre.slack.turn_delivery",
    {
      attributes: {
        "messaging.system": "slack",
        "messaging.destination.name": delivery.slackChannelId,
        "gen_ai.conversation.id": delivery.t3ThreadId,
        "t3.message_id": delivery.messageId,
        "compadre.delivery.attempt": delivery.attempts,
        "dd_llmobs_enabled": false,
      },
    },
  );
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    if (!store.renewClaim) return;
    void store.renewClaim(delivery.id).catch((error) =>
      logger.warn("[slack-delivery] failed to renew delivery claim", {
        deliveryId: delivery.id,
        error,
      }),
    );
  }, DELIVERY_CLAIM_HEARTBEAT_MS);
  heartbeat.unref();
  try {
    const dispatch = dispatchFor(delivery);
    const snapshot = await t3.waitForTurnTerminal({
      threadId: delivery.t3ThreadId,
      minimumSequence: dispatch.sequence,
      messageId: dispatch.messageId,
      requestedAt: dispatch.createdAt,
      timeoutMs: DELIVERY_WAIT_TIMEOUT_MS,
    });
    span.setAttribute("compadre.wait_terminal_ms", Date.now() - startedAt);
    span.addEvent("t3.turn.terminal");
    const state = snapshot.thread.latestTurn?.state;
    const incompleteReason = incompleteProviderStopReason(
      snapshot,
      snapshot.thread.latestTurn?.turnId,
    );
    const finalText = finalAssistantTextForDispatch(snapshot, dispatch);
    const failed =
      state === "error" ||
      state === "interrupted" ||
      Boolean(incompleteReason) ||
      !finalText;
    const response = failed
      ? slackFailureNotice(
          new Error(
            snapshot.thread.session?.lastError ||
              (state === "interrupted"
                ? "The agent run was interrupted before it completed."
                : incompleteReason
                  ? `The agent stopped before completing (${incompleteReason}).`
                : "The agent run completed without a final response."),
          ),
        )
      : finalText;

    await slack.postThreadMessage(response, delivery.id);
    span.setAttribute("compadre.slack_answer_ms", Date.now() - startedAt);
    span.addEvent("slack.answer.posted");
    await slack.postThreadContext(
      `<${delivery.detailsUrl}|Open in web>`,
      relatedUuid(delivery.id, "details"),
    );
    await slack.clearStatus();
    if (failed) {
      await slack.markRunFailed(delivery.triggerMessageTs);
    } else {
      await slack.markRunSucceeded(delivery.triggerMessageTs);
    }
    await store.markDelivered(delivery.id);
    span.setAttribute("compadre.delivery.failed_run", failed);
    logger.info("[slack-delivery] delivered native T3 completion", {
      deliveryId: delivery.id,
      messageId: delivery.messageId,
      threadId: delivery.t3ThreadId,
      state,
    });
    return true;
  } catch (error) {
    span.recordException(error instanceof Error ? error : String(error));
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    await store.markFailed(delivery, error);
    logger.warn("[slack-delivery] native T3 completion will retry", {
      deliveryId: delivery.id,
      messageId: delivery.messageId,
      attempts: delivery.attempts,
      error,
    });
    return false;
  } finally {
    clearInterval(heartbeat);
    span.setAttribute("compadre.delivery.total_ms", Date.now() - startedAt);
    span.end();
  }
}

export function createSlackTurnDeliveryProcessor(input: {
  store: SlackTurnDeliveryStore;
  botToken: string;
  centralT3Client?: CentralT3ConversationClient;
  logger?: Pick<Console, "info" | "warn" | "error">;
}) {
  const t3 = input.centralT3Client ?? configuredCentralT3Client();
  if (!t3) {
    throw new Error(
      "Slack completion recovery requires the central T3 URL and token.",
    );
  }
  let active: Promise<number> | undefined;
  const process = () => {
    if (active) return active;
    const current = (async () => {
      const runWorker = async () => {
        let delivered = 0;
        while (true) {
          const job = await input.store.claimNext();
          if (!job) return delivered;
          const slack = new SlackStream({
            channel: job.slackChannelId,
            threadTs: job.slackThreadTs,
            botToken: input.botToken,
            recipientUserId: job.recipientUserId ?? undefined,
            recipientTeamId: job.slackTeamId,
          });
          if (
            await deliverClaimedSlackTurn({
              delivery: job,
              store: input.store,
              t3,
              slack,
              logger: input.logger,
            })
          ) {
            delivered += 1;
          }
        }
      };
      const results = await Promise.all(
        Array.from({ length: DELIVERY_CONCURRENCY }, () => runWorker()),
      );
      return results.reduce((sum, count) => sum + count, 0);
    })().finally(() => {
      if (active === current) active = undefined;
    });
    active = current;
    return current;
  };
  return process;
}
