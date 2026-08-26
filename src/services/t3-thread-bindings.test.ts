import assert from "node:assert/strict";
import test from "node:test";
import { memoryPersistence } from "@tanstack/ai-persistence";
import {
  T3ThreadBindingStore,
  type T3ThreadBinding,
} from "./t3-thread-bindings.js";

const binding: T3ThreadBinding = {
  canonicalThreadId: "slack-thread",
  providerInstanceId: "codex",
  t3ThreadId: "t3-codex-thread",
  projectId: "project-1",
  sandboxId: "sandbox-1",
  baseUrl: "https://t3.example",
  modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
  createdAt: "2026-08-26T15:00:00.000Z",
  updatedAt: "2026-08-26T15:00:00.000Z",
};

test("persists separate native T3 threads for each provider harness", async () => {
  const persistence = memoryPersistence();
  const store = new T3ThreadBindingStore(persistence.stores.metadata);
  await store.bind(binding);
  await store.bind({
    ...binding,
    providerInstanceId: "claudeAgent",
    t3ThreadId: "t3-claude-thread",
    modelSelection: {
      instanceId: "claudeAgent",
      model: "claude-opus-4-6",
    },
  });

  assert.equal(
    (await store.get("slack-thread", "codex"))?.t3ThreadId,
    "t3-codex-thread",
  );
  assert.equal(
    (await store.get("slack-thread", "claudeAgent"))?.t3ThreadId,
    "t3-claude-thread",
  );
});

test("does not silently reassign a provider conversation", async () => {
  const persistence = memoryPersistence();
  const store = new T3ThreadBindingStore(persistence.stores.metadata);
  await store.bind(binding);
  await assert.rejects(
    store.bind({ ...binding, t3ThreadId: "different-thread" }),
    /already assigned to t3-codex-thread/,
  );
});
