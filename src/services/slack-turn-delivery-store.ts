import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import type { CompadreDatabase } from "../db/client.js";
import { slackTurnDeliveries } from "../db/schema.js";
import type { T3TurnDispatch } from "../t3/client.js";

const DEFAULT_CLAIM_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 12;
const MAX_RETRY_DELAY_MS = 5 * 60_000;

export type SlackTurnDelivery = typeof slackTurnDeliveries.$inferSelect;

export interface EnqueueSlackTurnDelivery {
  id: string;
  canonicalThreadId: string;
  t3ThreadId: string;
  environmentId: string;
  dispatch: T3TurnDispatch;
  slackTeamId: string;
  slackChannelId: string;
  slackThreadTs: string;
  triggerMessageTs: string;
  recipientUserId?: string;
  detailsUrl: string;
}

function deliveryInsertValues(
  input: EnqueueSlackTurnDelivery,
): typeof slackTurnDeliveries.$inferInsert {
  return {
    id: input.id,
    messageId: input.dispatch.messageId,
    canonicalThreadId: input.canonicalThreadId,
    t3ThreadId: input.t3ThreadId,
    environmentId: input.environmentId,
    dispatchSequence: input.dispatch.sequence,
    dispatchCreatedAt: new Date(input.dispatch.createdAt),
    slackTeamId: input.slackTeamId,
    slackChannelId: input.slackChannelId,
    slackThreadTs: input.slackThreadTs,
    triggerMessageTs: input.triggerMessageTs,
    recipientUserId: input.recipientUserId,
    detailsUrl: input.detailsUrl,
  };
}

/** Postgres-backed, restart-safe queue for native-T3 Slack completions. */
export class SlackTurnDeliveryStore {
  constructor(
    private readonly db: CompadreDatabase,
    private readonly options: {
      claimTtlMs?: number;
      maxAttempts?: number;
    } = {},
  ) {}

  async enqueue(input: EnqueueSlackTurnDelivery): Promise<SlackTurnDelivery> {
    await this.db
      .insert(slackTurnDeliveries)
      .values(deliveryInsertValues(input))
      .onConflictDoNothing({ target: slackTurnDeliveries.messageId });
    const row = await this.byMessageId(input.dispatch.messageId);
    if (!row) {
      throw new Error(
        `Could not enqueue Slack completion for ${input.dispatch.messageId}`,
      );
    }
    return row;
  }

  /**
   * Atomically enqueue and reserve a foreground delivery. Returning null means
   * an existing request or recovery worker already owns this message ID.
   */
  async enqueueClaimed(
    input: EnqueueSlackTurnDelivery,
    now = new Date(),
  ): Promise<SlackTurnDelivery | null> {
    const [inserted] = await this.db
      .insert(slackTurnDeliveries)
      .values({
        ...deliveryInsertValues(input),
        status: "delivering",
        attempts: 1,
        claimedAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: slackTurnDeliveries.messageId })
      .returning();
    return inserted ?? null;
  }

  async byMessageId(messageId: string): Promise<SlackTurnDelivery | null> {
    return (
      (
        await this.db
          .select()
          .from(slackTurnDeliveries)
          .where(eq(slackTurnDeliveries.messageId, messageId))
          .limit(1)
      )[0] ?? null
    );
  }

  async claimNext(now = new Date()): Promise<SlackTurnDelivery | null> {
    const staleBefore = new Date(
      now.getTime() - (this.options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS),
    );
    const claimable = or(
      and(
        eq(slackTurnDeliveries.status, "pending"),
        lte(slackTurnDeliveries.nextAttemptAt, now),
      ),
      and(
        eq(slackTurnDeliveries.status, "delivering"),
        lte(slackTurnDeliveries.claimedAt, staleBefore),
      ),
    );
    const candidates = await this.db
      .select({ id: slackTurnDeliveries.id })
      .from(slackTurnDeliveries)
      .where(claimable)
      .orderBy(
        asc(slackTurnDeliveries.nextAttemptAt),
        asc(slackTurnDeliveries.createdAt),
      )
      .limit(10);

    for (const candidate of candidates) {
      const [claimed] = await this.db
        .update(slackTurnDeliveries)
        .set({
          status: "delivering",
          attempts: sqlIncrement(slackTurnDeliveries.attempts),
          claimedAt: now,
          updatedAt: now,
        })
        .where(and(eq(slackTurnDeliveries.id, candidate.id), claimable))
        .returning();
      if (claimed) return claimed;
    }
    return null;
  }

  async claimByMessageId(
    messageId: string,
    now = new Date(),
  ): Promise<SlackTurnDelivery | null> {
    const [claimed] = await this.db
      .update(slackTurnDeliveries)
      .set({
        status: "delivering",
        attempts: sqlIncrement(slackTurnDeliveries.attempts),
        claimedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(slackTurnDeliveries.messageId, messageId),
          eq(slackTurnDeliveries.status, "pending"),
        ),
      )
      .returning();
    return claimed ?? null;
  }

  async markDelivered(
    delivery: Pick<SlackTurnDelivery, "id" | "attempts">,
    now = new Date(),
  ): Promise<boolean> {
    const [updated] = await this.db
      .update(slackTurnDeliveries)
      .set({
        status: "delivered",
        claimedAt: null,
        deliveredAt: now,
        lastError: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(slackTurnDeliveries.id, delivery.id),
          eq(slackTurnDeliveries.status, "delivering"),
          eq(slackTurnDeliveries.attempts, delivery.attempts),
        ),
      )
      .returning({ id: slackTurnDeliveries.id });
    return updated !== undefined;
  }

  async renewClaim(
    delivery: Pick<SlackTurnDelivery, "id" | "attempts">,
    now = new Date(),
  ): Promise<boolean> {
    const [updated] = await this.db
      .update(slackTurnDeliveries)
      .set({ claimedAt: now, updatedAt: now })
      .where(
        and(
          eq(slackTurnDeliveries.id, delivery.id),
          eq(slackTurnDeliveries.status, "delivering"),
          eq(slackTurnDeliveries.attempts, delivery.attempts),
        ),
      )
      .returning({ id: slackTurnDeliveries.id });
    return updated !== undefined;
  }

  async markFailed(
    delivery: Pick<SlackTurnDelivery, "id" | "attempts">,
    error: unknown,
    now = new Date(),
  ): Promise<void> {
    const maxAttempts = this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const dead = delivery.attempts >= maxAttempts;
    const retryDelayMs = Math.min(
      MAX_RETRY_DELAY_MS,
      1_000 * 2 ** Math.max(0, delivery.attempts - 1),
    );
    await this.db
      .update(slackTurnDeliveries)
      .set({
        status: dead ? "dead" : "pending",
        claimedAt: null,
        nextAttemptAt: new Date(now.getTime() + retryDelayMs),
        lastError: error instanceof Error ? error.message : String(error),
        updatedAt: now,
      })
      .where(
        and(
          eq(slackTurnDeliveries.id, delivery.id),
          eq(slackTurnDeliveries.status, "delivering"),
          eq(slackTurnDeliveries.attempts, delivery.attempts),
        ),
      );
  }
}

function sqlIncrement(column: typeof slackTurnDeliveries.attempts) {
  return sql<number>`${column} + 1`;
}
