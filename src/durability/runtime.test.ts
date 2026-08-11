import assert from "node:assert/strict";
import test from "node:test";
import { EventType, type StreamChunk } from "@tanstack/ai";
import {
  captureDurableRun,
  configuredDurabilityBackend,
  createAgentRunDurability,
} from "./runtime.js";

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

test("keeps durability opt-in and validates configured backends", () => {
  assert.equal(configuredDurabilityBackend({}), null);
  assert.equal(
    configuredDurabilityBackend({ COMPADRE_DURABILITY_BACKEND: "off" }),
    null,
  );
  assert.equal(
    configuredDurabilityBackend({ COMPADRE_DURABILITY_BACKEND: "memory" }),
    "memory",
  );
  assert.throws(
    () => configuredDurabilityBackend({ COMPADRE_DURABILITY_BACKEND: "redis" }),
    /must be off, memory, or postgres/,
  );
});

test("requires an explicit database URL for Postgres durability", async () => {
  await assert.rejects(
    createAgentRunDurability({ COMPADRE_DURABILITY_BACKEND: "postgres" }),
    /COMPADRE_DURABILITY_DATABASE_URL is required/,
  );
});

test("persists and replays a TanStack AG-UI run through the memory adapter", async () => {
  const durability = await createAgentRunDurability({
    COMPADRE_DURABILITY_BACKEND: "memory",
  });
  assert.ok(durability);
  const chunks: StreamChunk[] = [
    {
      type: EventType.RUN_STARTED,
      runId: "memory-run",
      threadId: "memory-thread",
      timestamp: 1,
    },
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "message",
      delta: "hello",
      timestamp: 2,
    },
    {
      type: EventType.RUN_FINISHED,
      runId: "memory-run",
      threadId: "memory-thread",
      finishReason: "stop",
      timestamp: 3,
    },
  ];
  const replayed = await collect(
    captureDurableRun(
      (async function* () {
        yield* chunks;
      })(),
      {
        runId: "memory-run",
        threadId: "memory-thread",
        durability,
      },
    ),
  );
  assert.deepEqual(replayed, chunks);
  assert.equal((await durability.runs.get("memory-run"))?.status, "completed");

  const snapshot = await durability.stream("memory-run").snapshot();
  assert.deepEqual(snapshot.map((entry) => entry.chunk), chunks);
});

test("turns a producer exception into a durable RUN_ERROR", async () => {
  const durability = await createAgentRunDurability({
    COMPADRE_DURABILITY_BACKEND: "memory",
  });
  assert.ok(durability);
  const replayed = await collect(
    captureDurableRun(
      (async function* () {
        yield {
          type: EventType.RUN_STARTED,
          runId: "failed-run",
          threadId: "failed-thread",
          timestamp: 1,
        } satisfies StreamChunk;
        throw new Error("producer exploded");
      })(),
      {
        runId: "failed-run",
        threadId: "failed-thread",
        durability,
      },
    ),
  );
  assert.equal(replayed.at(-1)?.type, EventType.RUN_ERROR);
  assert.equal((await durability.runs.get("failed-run"))?.status, "failed");
  assert.match(
    (await durability.runs.get("failed-run"))?.error?.message ?? "",
    /producer exploded/,
  );
});
