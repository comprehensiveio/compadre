import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import type { CompadreDatabase } from "../db/client.js";
import { slackInboxEvents } from "../db/schema.js";
import type { SlackEvent } from "../routes/slack-events.js";

const DEFAULT_CLAIM_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const MAX_RETRY_DELAY_MS = 5 * 60_000;

export type SlackInboxEvent = typeof slackInboxEvents.$inferSelect;

export interface EnqueueSlackInboxEvent {
  eventKey: string;
  teamId?: string;
  botUserId?: string;
  event: SlackEvent;
}

function sqlIncrement(column: typeof slackInboxEvents.attempts) {
  return sql`${column} + 1`;
}

/**
 * Durable Slack ingress queue. A verified event is inserted here BEFORE the
 * HTTP acknowledgment to Slack, so a crash or deploy between delivery and
 * turn dispatch can no longer lose a message: the replacement instance's
 * processor claims and routes the persisted row instead. `event_key` is
 * Slack's `event_id`, which is stable across Slack's own delivery retries,
 * so the insert doubles as restart-safe dedupe.
 */
export class SlackInboxStore {
  constructor(
    private readonly db: CompadreDatabase,
    private readonly options: {
      claimTtlMs?: number;
      maxAttempts?: number;
    } = {},
  ) {}

  /** Returns true when this delivery won the event (first sighting). */
  async enqueue(input: EnqueueSlackInboxEvent): Promise<boolean> {
    const [inserted] = await this.db
      .insert(slackInboxEvents)
      .values({
        eventKey: input.eventKey,
        teamId: input.teamId,
        botUserId: input.botUserId,
        event: input.event,
      })
      .onConflictDoNothing({ target: slackInboxEvents.eventKey })
      .returning({ eventKey: slackInboxEvents.eventKey });
    return inserted !== undefined;
  }

  /**
   * Claim the next routable event: queued rows whose backoff elapsed, or
   * processing rows whose claim went stale (a dead controller). Claims renew
   * while routing so the TTL only reclaims after a real crash.
   */
  async claimNext(now = new Date()): Promise<SlackInboxEvent | null> {
    const staleBefore = new Date(
      now.getTime() - (this.options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS),
    );
    const claimable = or(
      and(
        eq(slackInboxEvents.status, "queued"),
        lte(slackInboxEvents.nextAttemptAt, now),
      ),
      and(
        eq(slackInboxEvents.status, "processing"),
        lte(slackInboxEvents.claimedAt, staleBefore),
      ),
    );
    const candidates = await this.db
      .select({ eventKey: slackInboxEvents.eventKey })
      .from(slackInboxEvents)
      .where(claimable)
      .orderBy(
        asc(slackInboxEvents.createdAt),
        asc(slackInboxEvents.eventKey),
      )
      .limit(10);

    for (const candidate of candidates) {
      const [claimed] = await this.db
        .update(slackInboxEvents)
        .set({
          status: "processing",
          attempts: sqlIncrement(slackInboxEvents.attempts),
          claimedAt: now,
          updatedAt: now,
        })
        .where(
          and(eq(slackInboxEvents.eventKey, candidate.eventKey), claimable),
        )
        .returning();
      if (claimed) return claimed;
    }
    return null;
  }

  async renewClaim(
    row: Pick<SlackInboxEvent, "eventKey" | "attempts">,
    now = new Date(),
  ): Promise<boolean> {
    const [updated] = await this.db
      .update(slackInboxEvents)
      .set({ claimedAt: now, updatedAt: now })
      .where(
        and(
          eq(slackInboxEvents.eventKey, row.eventKey),
          eq(slackInboxEvents.status, "processing"),
          eq(slackInboxEvents.attempts, row.attempts),
        ),
      )
      .returning({ eventKey: slackInboxEvents.eventKey });
    return updated !== undefined;
  }

  /** Idempotent: marking done is safe from the dispatch hook and the tail. */
  async markDone(eventKey: string, now = new Date()): Promise<void> {
    await this.db
      .update(slackInboxEvents)
      .set({
        status: "done",
        claimedAt: null,
        lastError: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(slackInboxEvents.eventKey, eventKey),
          or(
            eq(slackInboxEvents.status, "processing"),
            eq(slackInboxEvents.status, "queued"),
          ),
        ),
      );
  }

  async markFailed(
    row: Pick<SlackInboxEvent, "eventKey" | "attempts">,
    error: unknown,
    now = new Date(),
  ): Promise<void> {
    const maxAttempts = this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const dead = row.attempts >= maxAttempts;
    const retryDelayMs = Math.min(
      MAX_RETRY_DELAY_MS,
      15_000 * 2 ** Math.max(0, row.attempts - 1),
    );
    await this.db
      .update(slackInboxEvents)
      .set({
        status: dead ? "dead" : "queued",
        claimedAt: null,
        nextAttemptAt: new Date(now.getTime() + retryDelayMs),
        lastError:
          error instanceof Error
            ? `${error.name}: ${error.message}`.slice(0, 500)
            : String(error).slice(0, 500),
        updatedAt: now,
      })
      .where(
        and(
          eq(slackInboxEvents.eventKey, row.eventKey),
          eq(slackInboxEvents.status, "processing"),
          eq(slackInboxEvents.attempts, row.attempts),
        ),
      );
  }
}
