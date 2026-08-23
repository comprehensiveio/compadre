import assert from "node:assert/strict";
import test from "node:test";
import { defineMetadataStore } from "@tanstack/ai-persistence";
import { metadataSandboxInstanceStore } from "./sandbox-instance-store.js";

test("persists and fully replaces Daytona instance records", async () => {
  const values = new Map<string, unknown>();
  const metadata = defineMetadataStore({
    get: async (namespace, key) => values.get(`${namespace}:${key}`) ?? null,
    set: async (namespace, key, value) => {
      values.set(`${namespace}:${key}`, value);
    },
    delete: async (namespace, key) => {
      values.delete(`${namespace}:${key}`);
    },
  });
  const store = metadataSandboxInstanceStore(metadata);
  await store.upsert({
    key: "thread-key",
    provider: "daytona",
    providerSandboxId: "sandbox-1",
    latestSnapshotId: "snapshot-1",
    latestRunId: "run-1",
    threadId: "thread-1",
    updatedAt: 1,
  });
  await store.upsert({
    key: "thread-key",
    provider: "daytona",
    providerSandboxId: "sandbox-1",
    threadId: "thread-1",
    updatedAt: 2,
  });

  assert.deepEqual(await store.get("thread-key"), {
    key: "thread-key",
    provider: "daytona",
    providerSandboxId: "sandbox-1",
    threadId: "thread-1",
    updatedAt: 2,
  });
  await store.delete("thread-key");
  assert.equal(await store.get("thread-key"), null);
});
