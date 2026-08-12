import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { EventType, type StreamChunk } from "@tanstack/ai";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { createDatabase } from "../db/client.js";
import { PostgresLockStore } from "../persistence/postgres.js";
import { createPostgresAgentRunDurability } from "./postgres.js";
import { captureDurableRun } from "./runtime.js";

const connectionString = process.env.COMPADRE_TEST_DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

test("closes an owned pool when schema initialization fails", async () => {
  let ended = false;
  const pool = {
    on: () => pool,
    query: async () => {
      throw new Error("schema connection failed");
    },
    end: async () => {
      ended = true;
      throw new Error("pool close failed");
    },
  } as unknown as pg.Pool;

  await assert.rejects(
    createPostgresAgentRunDurability({
      connectionString: "postgresql://localhost/test",
      poolFactory: () => pool,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        `${error.message}\n${String(error.cause)}`,
        /schema connection failed/,
      );
      return true;
    },
  );
  assert.equal(ended, true);
});

test(
  "Postgres adapter preserves run lifecycle fields and ordered stream replay",
  { skip: connectionString ? false : "set COMPADRE_TEST_DATABASE_URL" },
  async () => {
    assert.ok(connectionString);
    const pool = new pg.Pool({ connectionString });
    await migrate(createDatabase(pool), { migrationsFolder });
    const durability = await createPostgresAgentRunDurability({
      connectionString,
      pollIntervalMs: 10,
      pool,
    });
    const nonce = crypto.randomUUID();
    const runId = `postgres-run-${nonce}`;
    const threadId = `postgres-thread-${nonce}`;
    try {
      const original = await durability.runs.createOrResume({
        runId,
        threadId,
        startedAt: 100,
      });
      const resumed = await durability.runs.createOrResume({
        runId,
        threadId: "ignored",
        startedAt: 999,
        status: "failed",
      });
      assert.deepEqual(resumed, original);

      const concurrentRunId = `postgres-concurrent-${nonce}`;
      const concurrent = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          durability.runs.createOrResume({
            runId: concurrentRunId,
            threadId: `thread-${index}`,
            startedAt: index,
          }),
        ),
      );
      assert.equal(
        concurrent.every((record) => record.runId === concurrentRunId),
        true,
      );

      await durability.runs.update(runId, {
        sandboxKey: "sandbox",
        detachedSince: 200,
        cancelRequested: false,
        driverEpoch: 2,
      });
      const durableFields = await durability.runs.get(runId);
      assert.equal(durableFields?.sandboxKey, "sandbox");
      assert.equal(durableFields?.detachedSince, 200);
      assert.equal(durableFields?.cancelRequested, false);
      assert.equal(durableFields?.driverEpoch, 2);

      await durability.runs.update(runId, {
        sandboxKey: undefined,
        detachedSince: undefined,
        cancelRequested: undefined,
        driverEpoch: undefined,
      });
      const cleared = await durability.runs.get(runId);
      assert.equal(cleared?.sandboxKey, undefined);
      assert.equal(cleared?.detachedSince, undefined);
      assert.equal(cleared?.cancelRequested, undefined);
      assert.equal(cleared?.driverEpoch, undefined);

      const chunks: StreamChunk[] = [
        {
          type: EventType.RUN_STARTED,
          runId,
          threadId,
          timestamp: 1,
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "message",
          delta: "durable",
          timestamp: 2,
        },
      ];
      const stream = durability.stream(runId);
      const offsets = await stream.append(chunks);
      assert.equal(offsets.length, chunks.length);
      await stream.close();

      const replayed: StreamChunk[] = [];
      for await (const entry of durability.stream(runId).read("-1")) {
        replayed.push(entry.chunk);
      }
      assert.deepEqual(replayed, chunks);
      assert.deepEqual(
        (await durability.stream(runId).snapshot()).map((entry) => entry.chunk),
        chunks,
      );

      const liveRunId = `postgres-live-${nonce}`;
      await durability.runs.createOrResume({
        runId: liveRunId,
        threadId,
        startedAt: 2,
      });
      const liveStream = durability.stream(liveRunId);
      const liveReplay = (async () => {
        const replayed: StreamChunk[] = [];
        for await (const entry of liveStream.read("-1")) {
          replayed.push(entry.chunk);
        }
        return replayed;
      })();
      await liveStream.append(chunks);
      await liveStream.close();
      assert.deepEqual(await liveReplay, chunks);

      const drivenRunId = `postgres-driven-${nonce}`;
      const drivenChunks: StreamChunk[] = [
        {
          type: EventType.RUN_STARTED,
          runId: drivenRunId,
          threadId,
          timestamp: 3,
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "driven-message",
          delta: "through RunController",
          timestamp: 4,
        },
        {
          type: EventType.RUN_FINISHED,
          runId: drivenRunId,
          threadId,
          finishReason: "stop",
          timestamp: 5,
        },
      ];
      const drivenReplay: StreamChunk[] = [];
      for await (const chunk of captureDurableRun(
        (async function* () {
          yield* drivenChunks;
        })(),
        {
          runId: drivenRunId,
          threadId,
          durability: { backend: "postgres", ...durability },
        },
      )) {
        drivenReplay.push(chunk);
      }
      assert.deepEqual(drivenReplay, drivenChunks);
      assert.equal(
        (await durability.runs.get(drivenRunId))?.status,
        "completed",
      );

      const lockKey = `postgres-lock-${nonce}`;
      const locks = new PostgresLockStore(pool);
      let releaseFirst!: () => void;
      let markFirstAcquired!: () => void;
      const firstAcquired = new Promise<void>((resolve) => {
        markFirstAcquired = resolve;
      });
      const firstHolding = locks.withLock(
        lockKey,
        () => new Promise<void>((resolve) => {
          releaseFirst = resolve;
          markFirstAcquired();
        }),
      );
      await firstAcquired;
      let secondAcquired = false;
      const secondHolding = locks.withLock(lockKey, async () => {
        secondAcquired = true;
      });
      await waitForImmediate();
      assert.equal(secondAcquired, false);
      releaseFirst();
      await Promise.all([firstHolding, secondHolding]);
      assert.equal(secondAcquired, true);
    } finally {
      await durability.close();
      await pool.query(
        "DELETE FROM compadre_ai_streams WHERE run_id LIKE $1",
        [`%${nonce}`],
      );
      await pool.query(
        "DELETE FROM compadre_ai_runs WHERE run_id LIKE $1",
        [`%${nonce}`],
      );
      await pool.end();
    }
  },
);
