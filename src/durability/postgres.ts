import {
  isRunStatus,
  type RunRecord,
  type RunStore,
  type StreamChunk,
  type StreamDurability,
} from "@tanstack/ai";
import pg from "pg";
import { POSTGRES_DURABILITY_SCHEMA } from "./postgres-schema.js";

const OFFSET_PREFIX = "postgres:v1:";
const DEFAULT_POLL_INTERVAL_MS = 250;

interface RunRow {
  run_id: string;
  thread_id: string;
  status: unknown;
  started_at_ms: string | number;
  finished_at_ms: string | number | null;
  error: RunRecord["error"] | null;
  usage: RunRecord["usage"] | null;
  sandbox_key: string | null;
  detached_since_ms: string | number | null;
  cancel_requested: boolean | null;
  driver_epoch: string | number | null;
}

interface EventRow {
  sequence: string | number;
  chunk: StreamChunk;
}

export interface PostgresDurabilityOptions {
  connectionString: string;
  pollIntervalMs?: number;
  pool?: pg.Pool;
}

export interface PostgresAgentRunDurability {
  runs: RunStore;
  stream(runId: string): StreamDurability<string>;
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
    runId: row.run_id,
    threadId: row.thread_id,
    status: row.status,
    startedAt: asSafeNumber(row.started_at_ms, "started_at_ms"),
    ...(row.finished_at_ms === null
      ? {}
      : { finishedAt: asSafeNumber(row.finished_at_ms, "finished_at_ms") }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.usage === null ? {} : { usage: row.usage }),
    ...(row.sandbox_key === null ? {} : { sandboxKey: row.sandbox_key }),
    ...(row.detached_since_ms === null
      ? {}
      : {
          detachedSince: asSafeNumber(
            row.detached_since_ms,
            "detached_since_ms",
          ),
        }),
    ...(row.cancel_requested === null
      ? {}
      : { cancelRequested: row.cancel_requested }),
    ...(row.driver_epoch === null
      ? {}
      : { driverEpoch: asSafeNumber(row.driver_epoch, "driver_epoch") }),
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

export async function ensurePostgresDurabilitySchema(
  pool: pg.Pool,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('compadre-ai-durability-schema'))",
    );
    await client.query(POSTGRES_DURABILITY_SCHEMA);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function createRunStore(pool: pg.Pool): RunStore {
  return {
    async createOrResume(input) {
      const status = input.status ?? "running";
      const result = await pool.query<RunRow>(
        `WITH inserted AS (
           INSERT INTO compadre_ai_runs (
             run_id, thread_id, status, started_at_ms
           ) VALUES ($1, $2, $3, $4)
           ON CONFLICT (run_id) DO NOTHING
           RETURNING *
         ), ensured_stream AS (
           INSERT INTO compadre_ai_streams (run_id)
           VALUES ($1)
           ON CONFLICT (run_id) DO NOTHING
         )
         SELECT * FROM inserted
         UNION ALL
         SELECT * FROM compadre_ai_runs
         WHERE run_id = $1 AND NOT EXISTS (SELECT 1 FROM inserted)
         LIMIT 1`,
        [input.runId, input.threadId, status, input.startedAt],
      );
      const row = result.rows[0];
      if (row) return rowToRun(row);

      // ON CONFLICT can wait for a concurrent insert that was invisible to
      // this statement's snapshot. Read again in a fresh statement.
      const existing = await pool.query<RunRow>(
        "SELECT * FROM compadre_ai_runs WHERE run_id = $1",
        [input.runId],
      );
      const found = existing.rows[0];
      if (!found) throw new Error(`Could not create or load run ${input.runId}`);
      return rowToRun(found);
    },

    async update(runId, patch) {
      const assignments: string[] = [];
      const values: unknown[] = [runId];
      const add = (column: string, value: unknown) => {
        values.push(value ?? null);
        assignments.push(`${column} = $${values.length}`);
      };

      if (Object.hasOwn(patch, "status")) {
        if (patch.status === undefined) {
          throw new Error("A durable run status cannot be cleared");
        }
        add("status", patch.status);
      }
      if (Object.hasOwn(patch, "finishedAt")) {
        add("finished_at_ms", patch.finishedAt);
      }
      if (Object.hasOwn(patch, "error")) add("error", patch.error);
      if (Object.hasOwn(patch, "usage")) add("usage", patch.usage);
      if (Object.hasOwn(patch, "sandboxKey")) {
        add("sandbox_key", patch.sandboxKey);
      }
      if (Object.hasOwn(patch, "detachedSince")) {
        add("detached_since_ms", patch.detachedSince);
      }
      if (Object.hasOwn(patch, "cancelRequested")) {
        add("cancel_requested", patch.cancelRequested);
      }
      if (Object.hasOwn(patch, "driverEpoch")) {
        add("driver_epoch", patch.driverEpoch);
      }
      if (assignments.length === 0) return;

      await pool.query(
        `UPDATE compadre_ai_runs SET ${assignments.join(", ")} WHERE run_id = $1`,
        values,
      );
    },

    async get(runId) {
      const result = await pool.query<RunRow>(
        "SELECT * FROM compadre_ai_runs WHERE run_id = $1",
        [runId],
      );
      return result.rows[0] ? rowToRun(result.rows[0]) : null;
    },

    async listByThread(threadId) {
      const result = await pool.query<RunRow>(
        `SELECT * FROM compadre_ai_runs
         WHERE thread_id = $1
         ORDER BY started_at_ms ASC, run_id ASC`,
        [threadId],
      );
      return result.rows.map(rowToRun);
    },

    async listReclaimable({ now, ttlMs }) {
      const result = await pool.query<RunRow>(
        `SELECT * FROM compadre_ai_runs
         WHERE status = 'running'
           AND detached_since_ms IS NOT NULL
           AND detached_since_ms <= $1
         ORDER BY detached_since_ms ASC, run_id ASC`,
        [now - ttlMs],
      );
      return result.rows.map(rowToRun);
    },

    async findActiveRun(threadId) {
      const result = await pool.query<RunRow>(
        `SELECT * FROM compadre_ai_runs
         WHERE thread_id = $1 AND status = 'running'
         ORDER BY started_at_ms DESC, run_id DESC
         LIMIT 1`,
        [threadId],
      );
      return result.rows[0] ? rowToRun(result.rows[0]) : null;
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
  pool: pg.Pool,
  runId: string,
  pollIntervalMs: number,
): StreamDurability<string> {
  return {
    resumeFrom: () => null,

    async append(chunks) {
      if (chunks.length === 0) return [];
      const result = await pool.query<{ sequence: string | number }>(
        `WITH allocated AS (
           UPDATE compadre_ai_streams
           SET next_sequence = next_sequence + jsonb_array_length($2::jsonb)
           WHERE run_id = $1 AND closed_at IS NULL
           RETURNING next_sequence - jsonb_array_length($2::jsonb) AS first_sequence
         ), chunk_rows AS (
           SELECT value AS chunk, ordinality
           FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY
         )
         INSERT INTO compadre_ai_stream_events (run_id, sequence, chunk)
         SELECT $1, allocated.first_sequence + chunk_rows.ordinality - 1, chunk_rows.chunk
         FROM allocated CROSS JOIN chunk_rows
         RETURNING sequence`,
        [runId, JSON.stringify(chunks)],
      );
      if (result.rowCount !== chunks.length) {
        throw new Error(`Durable stream ${runId} is unknown or already closed`);
      }
      return result.rows
        .map((row) => asSafeNumber(row.sequence, "stream sequence"))
        .sort((a, b) => a - b)
        .map((sequence) => encodeOffset(runId, sequence));
    },

    async *read(offset, signal) {
      const decoded = decodeOffset(offset, runId);
      let cursor = decoded.kind === "sequence" ? decoded.sequence : 0;
      if (decoded.kind === "now") {
        const tail = await pool.query<{ next_sequence: string | number }>(
          "SELECT next_sequence FROM compadre_ai_streams WHERE run_id = $1",
          [runId],
        );
        const next = tail.rows[0]?.next_sequence;
        cursor = next === undefined ? 0 : asSafeNumber(next, "next_sequence") - 1;
      }

      while (true) {
        if (signal?.aborted) {
          throw signal.reason ?? new Error("Durable stream read aborted");
        }
        const events = await pool.query<EventRow>(
          `SELECT sequence, chunk
           FROM compadre_ai_stream_events
           WHERE run_id = $1 AND sequence > $2
           ORDER BY sequence ASC
           LIMIT 250`,
          [runId, cursor],
        );
        if (events.rows.length > 0) {
          for (const row of events.rows) {
            const sequence = asSafeNumber(row.sequence, "stream sequence");
            cursor = sequence;
            yield { offset: encodeOffset(runId, sequence), chunk: row.chunk };
          }
          continue;
        }

        const stream = await pool.query<{ closed_at: Date | null }>(
          "SELECT closed_at FROM compadre_ai_streams WHERE run_id = $1",
          [runId],
        );
        if (stream.rows[0]?.closed_at) {
          // An append that acquired the stream row lock before close() can
          // commit between the first event read and the closed_at read. Once
          // closed_at is visible no later append can succeed, so this final
          // read establishes a reliable end-of-stream boundary.
          while (true) {
            const finalEvents = await pool.query<EventRow>(
              `SELECT sequence, chunk
               FROM compadre_ai_stream_events
               WHERE run_id = $1 AND sequence > $2
               ORDER BY sequence ASC
               LIMIT 250`,
              [runId, cursor],
            );
            for (const row of finalEvents.rows) {
              const sequence = asSafeNumber(row.sequence, "stream sequence");
              cursor = sequence;
              yield {
                offset: encodeOffset(runId, sequence),
                chunk: row.chunk,
              };
            }
            if (finalEvents.rows.length < 250) return;
          }
        }
        await abortableDelay(pollIntervalMs, signal);
      }
    },

    async close() {
      await pool.query(
        `INSERT INTO compadre_ai_streams (run_id, closed_at)
         VALUES ($1, now())
         ON CONFLICT (run_id) DO UPDATE
         SET closed_at = COALESCE(compadre_ai_streams.closed_at, EXCLUDED.closed_at)`,
        [runId],
      );
    },

    async snapshot() {
      const result = await pool.query<EventRow>(
        `SELECT sequence, chunk
         FROM compadre_ai_stream_events
         WHERE run_id = $1
         ORDER BY sequence ASC`,
        [runId],
      );
      return result.rows.map((row) => {
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
  const pool = options.pool ?? new pg.Pool({
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
  await ensurePostgresDurabilitySchema(pool);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  return {
    runs: createRunStore(pool),
    stream: (runId) => createStreamDurability(pool, runId, pollIntervalMs),
    close: async () => {
      if (ownsPool) await pool.end();
    },
  };
}
