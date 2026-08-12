import {
  defineAIPersistence,
  defineInterruptStore,
  defineMessageStore,
  defineMetadataStore,
  type ChatPersistence,
  type InterruptRecord,
  type RunStore,
} from "@tanstack/ai-persistence";
import { and, asc, eq, type SQL } from "drizzle-orm";
import type { LockStore } from "@tanstack/ai/locks";
import pg from "pg";
import type { CompadreDatabase } from "../db/client.js";
import {
  aiInterrupts,
  aiMetadata,
  aiThreads,
} from "../db/schema.js";

function asSafeNumber(value: string | number, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`Invalid ${field} stored in Postgres: ${String(value)}`);
  }
  return number;
}

function mapInterrupt(
  row: typeof aiInterrupts.$inferSelect,
): InterruptRecord {
  return {
    interruptId: row.interruptId,
    runId: row.runId,
    threadId: row.threadId,
    status: row.status,
    requestedAt: asSafeNumber(row.requestedAtMs, "requested_at_ms"),
    payload: row.payload,
    ...(row.resolvedAtMs === null
      ? {}
      : { resolvedAt: asSafeNumber(row.resolvedAtMs, "resolved_at_ms") }),
    ...(row.response === null ? {} : { response: row.response }),
  };
}

/** Build the four TanStack chat stores over Compadre's existing Drizzle DB. */
export function createPostgresChatPersistence(
  db: CompadreDatabase,
  runs: RunStore,
): ChatPersistence {
  const messages = defineMessageStore({
    async loadThread(threadId) {
      const rows = await db
        .select({ messages: aiThreads.messages })
        .from(aiThreads)
        .where(eq(aiThreads.threadId, threadId))
        .limit(1);
      return rows[0]?.messages ?? [];
    },

    async saveThread(threadId, nextMessages) {
      await db
        .insert(aiThreads)
        .values({ threadId, messages: nextMessages })
        .onConflictDoUpdate({
          target: aiThreads.threadId,
          set: { messages: nextMessages, updatedAt: new Date() },
        });
    },
  });

  const listInterrupts = async (where: SQL | undefined) => {
    const rows = await db
      .select()
      .from(aiInterrupts)
      .where(where)
      .orderBy(asc(aiInterrupts.requestedAtMs), asc(aiInterrupts.interruptId));
    return rows.map(mapInterrupt);
  };
  const interrupts = defineInterruptStore({
    async create(record) {
      await db
        .insert(aiInterrupts)
        .values({
          interruptId: record.interruptId,
          runId: record.runId,
          threadId: record.threadId,
          status: "pending",
          requestedAtMs: record.requestedAt,
          payload: record.payload,
          ...(record.response === undefined
            ? {}
            : { response: record.response }),
        })
        .onConflictDoNothing({ target: aiInterrupts.interruptId });
    },

    async resolve(interruptId, response) {
      await db
        .update(aiInterrupts)
        .set({
          status: "resolved",
          resolvedAtMs: Date.now(),
          response: response ?? null,
        })
        .where(eq(aiInterrupts.interruptId, interruptId));
    },

    async cancel(interruptId) {
      await db
        .update(aiInterrupts)
        .set({ status: "cancelled", resolvedAtMs: Date.now() })
        .where(eq(aiInterrupts.interruptId, interruptId));
    },

    async get(interruptId) {
      const rows = await db
        .select()
        .from(aiInterrupts)
        .where(eq(aiInterrupts.interruptId, interruptId))
        .limit(1);
      return rows[0] ? mapInterrupt(rows[0]) : null;
    },

    list: (threadId) => listInterrupts(eq(aiInterrupts.threadId, threadId)),
    listPending: (threadId) =>
      listInterrupts(
        and(
          eq(aiInterrupts.threadId, threadId),
          eq(aiInterrupts.status, "pending"),
        ),
      ),
    listByRun: (runId) => listInterrupts(eq(aiInterrupts.runId, runId)),
    listPendingByRun: (runId) =>
      listInterrupts(
        and(
          eq(aiInterrupts.runId, runId),
          eq(aiInterrupts.status, "pending"),
        ),
      ),
  });

  const metadata = defineMetadataStore({
    async get(namespace, key) {
      const rows = await db
        .select({ value: aiMetadata.value })
        .from(aiMetadata)
        .where(
          and(
            eq(aiMetadata.namespace, namespace),
            eq(aiMetadata.key, key),
          ),
        )
        .limit(1);
      return rows[0]?.value ?? null;
    },

    async set(namespace, key, value) {
      if (value === null || value === undefined) {
        throw new TypeError(
          `Cannot store ${value} for (${namespace}, ${key}); use delete() to clear metadata.`,
        );
      }
      await db
        .insert(aiMetadata)
        .values({ namespace, key, value })
        .onConflictDoUpdate({
          target: [aiMetadata.namespace, aiMetadata.key],
          set: { value },
        });
    },

    async delete(namespace, key) {
      await db
        .delete(aiMetadata)
        .where(
          and(
            eq(aiMetadata.namespace, namespace),
            eq(aiMetadata.key, key),
          ),
        );
    },
  });

  return defineAIPersistence({
    stores: { messages, runs, interrupts, metadata },
  });
}

export async function validatePostgresChatPersistenceSchema(
  db: CompadreDatabase,
): Promise<void> {
  await Promise.all([
    db.select({ threadId: aiThreads.threadId }).from(aiThreads).limit(0),
    db
      .select({ interruptId: aiInterrupts.interruptId })
      .from(aiInterrupts)
      .limit(0),
    db.select({ key: aiMetadata.key }).from(aiMetadata).limit(0),
  ]);
}

/** PostgreSQL advisory locks are process-independent and connection-scoped. */
export class PostgresLockStore implements LockStore {
  constructor(private readonly pool: pg.Pool) {}

  async withLock<T>(
    key: string,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    const abortController = new AbortController();
    const onConnectionError = (error: Error) => abortController.abort(error);
    client.on("error", onConnectionError);
    let locked = false;
    try {
      await client.query(
        "SELECT pg_advisory_lock(hashtextextended($1, 0))",
        [key],
      );
      locked = true;
      if (abortController.signal.aborted) {
        throw abortController.signal.reason;
      }
      return await fn(abortController.signal);
    } finally {
      client.off("error", onConnectionError);
      if (locked && !abortController.signal.aborted) {
        await client
          .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key])
          .catch(() => undefined);
      }
      client.release(abortController.signal.aborted);
    }
  }
}
