import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryLockStore, type MetadataStore } from "./storage.js";
import {
  appendSetupSteering,
  NativeT3RunControlStore,
} from "./run-control.js";

function memoryMetadata(): MetadataStore {
  const values = new Map<string, unknown>();
  return {
    async get(namespace, key) {
      return values.get(`${namespace}:${key}`) ?? null;
    },
    async set(namespace, key, value) {
      values.set(`${namespace}:${key}`, structuredClone(value));
    },
    async delete(namespace, key) {
      values.delete(`${namespace}:${key}`);
    },
  };
}

test("queues steering in order and deduplicates update retries", async () => {
  const store = new NativeT3RunControlStore(
    memoryMetadata(),
    new InMemoryLockStore(),
  );
  await store.enqueue("run-1", { id: "second", text: "count to 50" });
  await store.enqueue("run-1", { id: "third", text: "use bash" });
  await store.enqueue("run-1", { id: "second", text: "count to 50" });

  assert.deepEqual(await store.pending("run-1"), [
    { id: "second", text: "count to 50", state: "pending" },
    { id: "third", text: "use bash", state: "pending" },
  ]);
  await store.settle("run-1", "second", "delivered");
  assert.deepEqual(await store.pending("run-1"), [
    { id: "third", text: "use bash", state: "pending" },
  ]);
});

test("formats setup steering as ordered follow-up instructions", () => {
  assert.equal(
    appendSetupSteering("count to 30", [
      { text: "actually count to 50" },
      { text: "use bash" },
    ]),
    [
      "count to 30",
      "Follow-up instruction received during setup:\nactually count to 50",
      "Follow-up instruction received during setup:\nuse bash",
    ].join("\n\n"),
  );
});
