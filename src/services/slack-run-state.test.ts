import assert from "node:assert/strict";
import test from "node:test";
import { memoryPersistence } from "@tanstack/ai-persistence";
import { SlackRunStateStore } from "./slack-run-state.js";

test("resolves and forgets the exact durable run for a Slack message", async () => {
  const persistence = memoryPersistence();
  const store = new SlackRunStateStore(
    persistence.stores.metadata,
    persistence.stores.runs,
  );
  await persistence.stores.runs.createOrResume({
    runId: "run-1",
    threadId: "thread-1",
    startedAt: 123,
  });

  assert.equal(await store.resolve("C123", "100.001"), null);
  await store.record("C123", "100.001", "run-1");
  assert.equal((await store.resolve("C123", "100.001"))?.runId, "run-1");

  await store.forget("C123", "100.001");
  assert.equal(await store.resolve("C123", "100.001"), null);
});
