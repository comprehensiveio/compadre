import assert from "node:assert/strict";
import test from "node:test";
import { EventType, InMemoryRunStore, memoryStream } from "@tanstack/ai";
import type { AgentRunDurability } from "../durability/runtime.js";
import { executeDurabilityProbe } from "./durability-probe.js";

test("proves an ordered durable replay without returning message content", async () => {
  const runId = "durable-run";
  const runs = new InMemoryRunStore();
  const stream = memoryStream({ runId });
  const durability: AgentRunDurability = {
    backend: "memory",
    runs,
    stream: () => stream,
    close: async () => undefined,
  };
  await runs.createOrResume({ runId, threadId: "thread", startedAt: 1 });
  await runs.update(runId, { status: "completed", finishedAt: 2 });
  await stream.append([
    {
      type: EventType.RUN_STARTED,
      runId,
      threadId: "thread",
      timestamp: 1,
    },
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "message",
      delta: "hi",
      timestamp: 2,
    },
    {
      type: EventType.RUN_FINISHED,
      runId,
      threadId: "thread",
      timestamp: 3,
    },
  ]);
  await stream.close();

  const result = await executeDurabilityProbe(
    { runId, expectedText: "hi" },
    { getDurability: async () => durability },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.hasFinishedAt, true);
  assert.equal(result.hasError, false);
  assert.equal(result.snapshotEventCount, 3);
  assert.equal(result.replayEventCount, 3);
  assert.equal(result.replayMatchesSnapshot, true);
  assert.equal(result.expectedTextMatches, true);
  assert.equal("replayedText" in result, false);
});
