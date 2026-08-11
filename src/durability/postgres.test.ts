import assert from "node:assert/strict";
import test from "node:test";
import { EventType, type StreamChunk } from "@tanstack/ai";
import { createPostgresAgentRunDurability } from "./postgres.js";
import { captureDurableRun } from "./runtime.js";

const connectionString = process.env.COMPADRE_TEST_DATABASE_URL;

test(
  "Postgres adapter preserves run lifecycle fields and ordered stream replay",
  { skip: connectionString ? false : "set COMPADRE_TEST_DATABASE_URL" },
  async () => {
    assert.ok(connectionString);
    const durability = await createPostgresAgentRunDurability({
      connectionString,
      pollIntervalMs: 10,
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
    } finally {
      await durability.close();
    }
  },
);
