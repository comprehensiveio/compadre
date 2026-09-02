import type { SlackEvent } from "../routes/slack-events.js";
import type { SlackInboxEvent, SlackInboxStore } from "./slack-inbox-store.js";

/**
 * Slack ingress durability selector.
 *
 * "durable": verified AI-routable events are persisted to Postgres BEFORE the
 *   HTTP acknowledgment and routed by the inbox processor, so deploys and
 *   crashes cannot lose a message (2026-09-01: a `continue` reply was lost in
 *   exactly that ack-then-die window during a rollout).
 * "direct": the pre-inbox behavior — acknowledge, then fire-and-forget.
 *
 * Code-level kill switch by convention (like NATIVE_T3_RUN_ORCHESTRATOR).
 */
export const SLACK_INGRESS_MODE: "durable" | "direct" = "durable";

const INBOX_CLAIM_HEARTBEAT_MS = 60_000;
const INBOX_CONCURRENCY = 2;
export const DEFAULT_SLACK_INBOX_INTERVAL_MS = 5_000;

export interface SlackInboxRouteHooks {
  /**
   * Invoked as soon as the turn is durably owned downstream (central
   * dispatch committed and the delivery outbox row reserved). After this
   * point a crash is recovered by the outbox and the run orchestrator, so
   * the inbox row must not be retried.
   */
  onDurablyDispatched(): Promise<void> | void;
}

export type SlackInboxRouter = (
  event: SlackEvent,
  teamId: string | undefined,
  botUserId: string | undefined,
  hooks: SlackInboxRouteHooks,
) => Promise<void>;

/**
 * Single-flight processor over the durable Slack inbox. Runs in-process next
 * to the delivery-outbox processor: claims routable rows, renews the claim
 * while the (potentially minutes-long) pre-dispatch phase runs, marks rows
 * done at durable dispatch, and requeues with backoff on failure.
 */
export function createSlackInboxProcessor(options: {
  store: SlackInboxStore;
  route: SlackInboxRouter;
}): () => Promise<void> {
  const { store, route } = options;
  let inFlight: Promise<void> | undefined;

  async function processOne(row: SlackInboxEvent): Promise<void> {
    let settled = false;
    const heartbeat = setInterval(() => {
      if (settled) return;
      void store.renewClaim(row).catch((error) =>
        console.warn("[slack-inbox] claim renewal failed", {
          eventKey: row.eventKey,
          error,
        }),
      );
    }, INBOX_CLAIM_HEARTBEAT_MS);
    heartbeat.unref();
    try {
      await route(
        row.event as SlackEvent,
        row.teamId ?? undefined,
        row.botUserId ?? undefined,
        {
          onDurablyDispatched: async () => {
            settled = true;
            clearInterval(heartbeat);
            await store.markDone(row.eventKey).catch((error) =>
              console.error("[slack-inbox] could not mark dispatched event done", {
                eventKey: row.eventKey,
                error,
              }),
            );
          },
        },
      );
      // Routing finished without a dispatch (filtered message, error notice
      // already posted, mention-only no-op): the event is consumed.
      if (!settled) await store.markDone(row.eventKey);
    } catch (error) {
      console.error("[slack-inbox] routing failed", {
        eventKey: row.eventKey,
        attempts: row.attempts,
        error,
      });
      if (!settled) await store.markFailed(row, error);
    } finally {
      settled = true;
      clearInterval(heartbeat);
    }
  }

  return function processSlackInbox(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const workers = Array.from({ length: INBOX_CONCURRENCY }, async () => {
        for (;;) {
          const row = await store.claimNext();
          if (!row) return;
          await processOne(row);
        }
      });
      await Promise.all(workers);
    })()
      .catch((error) => console.error("[slack-inbox] processor failed", error))
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}

interface ConfiguredSlackInbox {
  store: SlackInboxStore;
  poke: () => void;
}

let configured: ConfiguredSlackInbox | undefined;

/** Wired at startup when Postgres durability and Slack are enabled. */
export function setConfiguredSlackInbox(
  inbox: ConfiguredSlackInbox | undefined,
): void {
  configured = inbox;
}

export function getConfiguredSlackInbox(): ConfiguredSlackInbox | undefined {
  return SLACK_INGRESS_MODE === "durable" ? configured : undefined;
}
