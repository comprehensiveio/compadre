import {
  isRunStatus,
  type RunRecord,
  type RunStore,
  type StreamChunk,
  type StreamDurability,
} from "@tanstack/ai";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  lte,
  sql,
} from "drizzle-orm";
import pg from "pg";
import {
  createDatabase,
  type CompadreDatabase,
} from "../db/client.js";
import {
  aiRuns,
  aiStreamEvents,
  aiStreams,
} from "../db/schema.js";

const OFFSET_PREFIX = "postgres:v1:";
const DEFAULT_POLL_INTERVAL_MS = 250;

type RunRow = typeof aiRuns.$inferSelect;
type EventRow = Pick<
  typeof aiStreamEvents.$inferSelect,
  "sequence" | "chunk"
>;

export interface PostgresDurabilityOptions {
  connectionString: string;
  pollIntervalMs?: number;
  pool?: pg.Pool;
  poolFactory?: (config: pg.PoolConfig) => pg.Pool;
}

export interface PostgresAgentRunDurability {
  runs: RunStore;
  stream(runId: string): StreamDurability<string>;
  pool: pg.Pool;
  database: CompadreDatabase;
  close(): Promise<void>;
}

function asSafeNumber(value: string | number, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`Invalid ${field} stored in Postgres: ${String(value)}`);
  }
  return number;
}

function rowToRun(row: RunRow): RunRecord {
  if (!isRunStatus(row.status)) {
    throw new Error(`Invalid run status stored in Postgres: ${String(row.status)}`);
  }
  return {
    runId: row.runId,
    threadId: row.threadId,
    status: row.status,
    startedAt: asSafeNumber(row.startedAtMs, "started_at_ms"),
    ...(row.finishedAtMs === null
      ? {}
      : { finishedAt: asSafeNumber(row.finishedAtMs, "finished_at_ms") }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.usage === null ? {} : { usage: row.usage }),
    ...(row.sandboxKey === null ? {} : { sandboxKey: row.sandboxKey }),
    ...(row.detachedSinceMs === null
      ? {}
      : {
          detachedSince: asSafeNumber(
            row.detachedSinceMs,
            "detached_since_ms",
          ),
        }),
    ...(row.cancelRequested === null
      ? {}
      : { cancelRequested: row.cancelRequested }),
    ...(row.driverEpoch === null
      ? {}
      : { driverEpoch: asSafeNumber(row.driverEpoch, "driver_epoch") }),
  };
}

function sslForConnectionString(
  connectionString: string,
): pg.PoolConfig["ssl"] {
  try {
    const hostname = new URL(connectionString).hostname;
    return hostname.endsWith(".render.com")
      ? { rejectUnauthorized: true }
      : undefined;
  } catch {
    return undefined;
  }
}

async function validatePostgresDurabilitySchema(
  db: CompadreDatabase,
): Promise<void> {
  await Promise.all([
    db.select({ runId: aiRuns.runId }).from(aiRuns).limit(0),
    db.select({ runId: aiStreams.runId }).from(aiStreams).limit(0),
    db.select({ runId: aiStreamEvents.runId }).from(aiStreamEvents).limit(0),
  ]);
}

export function createPostgresRunStore(db: CompadreDatabase): RunStore {
  return {
    async createOrResume(input) {
      const status = input.status ?? "running";
      return db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(aiRuns)
          .values({
            runId: input.runId,
            threadId: input.threadId,
            status,
            startedAtMs: input.startedAt,
          })
          .onConflictDoNothing({ target: aiRuns.runId })
          .returning();
        await tx
          .insert(aiStreams)
          .values({ runId: input.runId })
          .onConflictDoNothing({ target: aiStreams.runId });
        const row =
          inserted ??
          (
            await tx
              .select()
              .from(aiRuns)
              .where(eq(aiRuns.runId, input.runId))
              .limit(1)
          )[0];
        if (!row) {
          throw new Error(`Could not create or load run ${input.runId}`);
        }
        return rowToRun(row);
      });
    },

    async update(runId, patch) {
      const values: Partial<typeof aiRuns.$inferInsert> = {};

      if (Object.hasOwn(patch, "status")) {
        if (patch.status === undefined) {
          throw new Error("A durable run status cannot be cleared");
        }
        values.status = patch.status;
      }
      if (Object.hasOwn(patch, "finishedAt")) {
        values.finishedAtMs = patch.finishedAt ?? null;
      }
      if (Object.hasOwn(patch, "error")) values.error = patch.error ?? null;
      if (Object.hasOwn(patch, "usage")) values.usage = patch.usage ?? null;
      if (Object.hasOwn(patch, "sandboxKey")) {
        values.sandboxKey = patch.sandboxKey ?? null;
      }
      if (Object.hasOwn(patch, "detachedSince")) {
        values.detachedSinceMs = patch.detachedSince ?? null;
      }
      if (Object.hasOwn(patch, "cancelRequested")) {
        values.cancelRequested = patch.cancelRequested ?? null;
      }
      if (Object.hasOwn(patch, "driverEpoch")) {
        values.driverEpoch = patch.driverEpoch ?? null;
      }
      if (Object.keys(values).length === 0) return;

      await db.update(aiRuns).set(values).where(eq(aiRuns.runId, runId));
    },

    async get(runId) {
      const row = (
        await db
          .select()
          .from(aiRuns)
          .where(eq(aiRuns.runId, runId))
          .limit(1)
      )[0];
      return row ? rowToRun(row) : null;
    },

    async listByThread(threadId) {
      const rows = await db
        .select()
        .from(aiRuns)
        .where(eq(aiRuns.threadId, threadId))
        .orderBy(asc(aiRuns.startedAtMs), asc(aiRuns.runId));
      return rows.map(rowToRun);
    },

    async listReclaimable({ now, ttlMs }) {
      const rows = await db
        .select()
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.status, "running"),
            isNotNull(aiRuns.detachedSinceMs),
            lte(aiRuns.detachedSinceMs, now - ttlMs),
          ),
        )
        .orderBy(asc(aiRuns.detachedSinceMs), asc(aiRuns.runId));
      return rows.map(rowToRun);
    },

    async findActiveRun(threadId) {
      const row = (
        await db
          .select()
          .from(aiRuns)
          .where(
            and(
              eq(aiRuns.threadId, threadId),
              eq(aiRuns.status, "running"),
            ),
          )
          .orderBy(desc(aiRuns.startedAtMs), desc(aiRuns.runId))
          .limit(1)
      )[0];
      return row ? rowToRun(row) : null;
    },
  };
}

function encodeOffset(runId: string, sequence: number): string {
  return `${OFFSET_PREFIX}${encodeURIComponent(runId)}:${sequence}`;
}

function decodeOffset(
  offset: string,
  runId: string,
): { kind: "start" | "now" } | { kind: "sequence"; sequence: number } {
  if (offset === "-1") return { kind: "start" };
  if (offset === "now") return { kind: "now" };
  if (!offset.startsWith(OFFSET_PREFIX)) {
    throw new Error(`Invalid Postgres stream offset: ${offset}`);
  }
  const encoded = offset.slice(OFFSET_PREFIX.length);
  const separator = encoded.lastIndexOf(":");
  if (separator === -1) {
    throw new Error(`Invalid Postgres stream offset: ${offset}`);
  }
  const offsetRunId = decodeURIComponent(encoded.slice(0, separator));
  const sequence = Number(encoded.slice(separator + 1));
  if (offsetRunId !== runId) {
    throw new Error(
      `Postgres stream offset belongs to run ${offsetRunId}, not ${runId}`,
    );
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error(`Invalid Postgres stream offset: ${offset}`);
  }
  return { kind: "sequence", sequence };
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Durable stream read aborted"));
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new Error("Durable stream read aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function createStreamDurability(
  db: CompadreDatabase,
  runId: string,
  pollIntervalMs: number,
): StreamDurability<string> {
  return {
    resumeFrom: () => null,

    async append(chunks) {
      if (chunks.length === 0) return [];
      return db.transaction(async (tx) => {
        const [stream] = await tx
          .update(aiStreams)
          .set({
            nextSequence: sql`${aiStreams.nextSequence} + ${chunks.length}`,
          })
          .where(
            and(eq(aiStreams.runId, runId), isNull(aiStreams.closedAt)),
          )
          .returning({ nextSequence: aiStreams.nextSequence });
        if (!stream) {
          throw new Error(`Durable stream ${runId} is unknown or already closed`);
        }
        const firstSequence =
          asSafeNumber(stream.nextSequence, "next_sequence") - chunks.length;
        await tx
          .insert(aiStreamEvents)
          .values(
            chunks.map((chunk, index) => ({
              runId,
              sequence: firstSequence + index,
              chunk,
            })),
          );
        return chunks.map((_, index) =>
          encodeOffset(runId, firstSequence + index),
        );
      });
    },

    async *read(offset, signal) {
      const decoded = decodeOffset(offset, runId);
      let cursor = decoded.kind === "sequence" ? decoded.sequence : 0;
      if (decoded.kind === "now") {
        const tail = await db
          .select({ nextSequence: aiStreams.nextSequence })
          .from(aiStreams)
          .where(eq(aiStreams.runId, runId))
          .limit(1);
        const next = tail[0]?.nextSequence;
        cursor = next === undefined ? 0 : asSafeNumber(next, "next_sequence") - 1;
      }

      while (true) {
        if (signal?.aborted) {
          throw signal.reason ?? new Error("Durable stream read aborted");
        }
        const events: EventRow[] = await db
          .select({
            sequence: aiStreamEvents.sequence,
            chunk: aiStreamEvents.chunk,
          })
          .from(aiStreamEvents)
          .where(
            and(
              eq(aiStreamEvents.runId, runId),
              gt(aiStreamEvents.sequence, cursor),
            ),
          )
          .orderBy(asc(aiStreamEvents.sequence))
          .limit(250);
        if (events.length > 0) {
          for (const row of events) {
            const sequence = asSafeNumber(row.sequence, "stream sequence");
            cursor = sequence;
            yield { offset: encodeOffset(runId, sequence), chunk: row.chunk };
          }
          continue;
        }

        const stream = await db
          .select({ closedAt: aiStreams.closedAt })
          .from(aiStreams)
          .where(eq(aiStreams.runId, runId))
          .limit(1);
        if (stream[0]?.closedAt) {
          // An append that acquired the stream row lock before close() can
          // commit between the first event read and the closed_at read. Once
          // closed_at is visible no later append can succeed, so this final
          // read establishes a reliable end-of-stream boundary.
          while (true) {
            const finalEvents: EventRow[] = await db
              .select({
                sequence: aiStreamEvents.sequence,
                chunk: aiStreamEvents.chunk,
              })
              .from(aiStreamEvents)
              .where(
                and(
                  eq(aiStreamEvents.runId, runId),
                  gt(aiStreamEvents.sequence, cursor),
                ),
              )
              .orderBy(asc(aiStreamEvents.sequence))
              .limit(250);
            for (const row of finalEvents) {
              const sequence = asSafeNumber(row.sequence, "stream sequence");
              cursor = sequence;
              yield {
                offset: encodeOffset(runId, sequence),
                chunk: row.chunk,
              };
            }
            if (finalEvents.length < 250) return;
          }
        }
        await abortableDelay(pollIntervalMs, signal);
      }
    },

    async close() {
      await db
        .insert(aiStreams)
        .values({ runId, closedAt: sql`now()` })
        .onConflictDoUpdate({
          target: aiStreams.runId,
          set: {
            closedAt: sql`coalesce(${aiStreams.closedAt}, excluded.closed_at)`,
          },
        });
    },

    async snapshot() {
      const rows: EventRow[] = await db
        .select({
          sequence: aiStreamEvents.sequence,
          chunk: aiStreamEvents.chunk,
        })
        .from(aiStreamEvents)
        .where(eq(aiStreamEvents.runId, runId))
        .orderBy(asc(aiStreamEvents.sequence));
      return rows.map((row) => {
        const sequence = asSafeNumber(row.sequence, "stream sequence");
        return { offset: encodeOffset(runId, sequence), chunk: row.chunk };
      });
    },
  };
}

export async function createPostgresAgentRunDurability(
  options: PostgresDurabilityOptions,
): Promise<PostgresAgentRunDurability> {
  const ownsPool = options.pool === undefined;
  const createPool = options.poolFactory ?? ((config) => new pg.Pool(config));
  const pool = options.pool ?? createPool({
    connectionString: options.connectionString,
    ssl: sslForConnectionString(options.connectionString),
    max: 4,
    allowExitOnIdle: true,
    application_name: "compadre-durability",
  });
  if (ownsPool) {
    pool.on("error", (error) => {
      console.error("[durability] idle Postgres connection failed", error);
    });
  }
  const db = createDatabase(pool);
  try {
    await validatePostgresDurabilitySchema(db);
  } catch (error) {
    if (ownsPool) {
      await pool.end().catch(() => undefined);
    }
    throw error;
  }
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  return {
    runs: createPostgresRunStore(db),
    stream: (runId) => createStreamDurability(db, runId, pollIntervalMs),
    pool,
    database: db,
    close: async () => {
      if (ownsPool) await pool.end();
    },
  };
}
