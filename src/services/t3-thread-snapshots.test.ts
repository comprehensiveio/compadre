import assert from "node:assert/strict";
import test from "node:test";
import { memoryPersistence } from "@tanstack/ai-persistence";
import type { T3ThreadSnapshot } from "../t3/client.js";
import type { T3ThreadBinding } from "./t3-thread-bindings.js";
import { T3ThreadSnapshotStore } from "./t3-thread-snapshots.js";

const binding: T3ThreadBinding = {
  canonicalThreadId: "slack-thread",
  providerInstanceId: "claudeAgent",
  t3ThreadId: "t3-thread",
  projectId: "project-1",
  sandboxId: "sandbox-1",
  baseUrl: "https://modal.example",
  modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
  status: "ready",
  createdAt: "2026-08-26T15:00:00.000Z",
  updatedAt: "2026-08-26T15:00:00.000Z",
};

function snapshot(sequence: number): T3ThreadSnapshot {
  return {
    snapshotSequence: sequence,
    thread: {
      id: "t3-thread",
      projectId: "project-1",
      title: "Thread",
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
      latestTurn: null,
      messages: [],
      session: null,
      activities: [
        {
          id: "activity-1",
          type: "command.completed",
          title: "pwd",
          output: "/workspace",
        },
      ],
    },
  };
}

test("persists complete native T3 snapshots in central metadata", async () => {
  const persistence = memoryPersistence();
  const store = new T3ThreadSnapshotStore(
    persistence.stores.metadata,
    undefined,
    () => new Date("2026-08-26T15:01:00.000Z"),
  );

  await store.save(binding, snapshot(12));
  const persisted = await store.get(binding.canonicalThreadId);

  assert.equal(persisted?.capturedAt, "2026-08-26T15:01:00.000Z");
  assert.deepEqual(persisted?.snapshot.thread.activities, [
    {
      id: "activity-1",
      type: "command.completed",
      title: "pwd",
      output: "/workspace",
    },
  ]);
});

test("does not replace a newer centralized snapshot with a stale poll", async () => {
  const persistence = memoryPersistence();
  const store = new T3ThreadSnapshotStore(persistence.stores.metadata);

  await store.save(binding, snapshot(12));
  const retained = await store.save(binding, snapshot(11));

  assert.equal(retained.snapshot.snapshotSequence, 12);
  assert.equal((await store.get(binding.canonicalThreadId))?.snapshot.snapshotSequence, 12);
});

test("does not rewrite an identical centralized snapshot", async () => {
  const persistence = memoryPersistence();
  const store = new T3ThreadSnapshotStore(persistence.stores.metadata);

  const first = await store.save(binding, snapshot(12));
  const retained = await store.save(binding, {
    ...snapshot(12),
    thread: { ...snapshot(12).thread, title: "Same sequence, later poll" },
  });

  assert.equal(retained.capturedAt, first.capturedAt);
  assert.equal(retained.snapshot.thread.title, "Thread");
});

test("rejects snapshots from a different native T3 thread", async () => {
  const persistence = memoryPersistence();
  const store = new T3ThreadSnapshotStore(persistence.stores.metadata);
  const mismatched = snapshot(1);
  mismatched.thread.id = "another-thread";

  await assert.rejects(store.save(binding, mismatched), /does not match binding/);
});
