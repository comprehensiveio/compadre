import assert from "node:assert/strict";
import test from "node:test";
import { memoryPersistence } from "@tanstack/ai-persistence";
import { NativeT3RunRequestStore, type NativeT3RunRequest } from "./run-request-store.js";

const request: NativeT3RunRequest = {
  runId: "run-1", canonicalThreadId: "thread-1", provider: "codex", title: "Test", text: "Inspect attachments",
  modelSelection: { instanceId: "codex", model: "gpt-5" }, inputFiles: [], collectArtifacts: false,
  createdAt: "2026-09-11T12:00:00.000Z",
};

test("large image requests persist references only and hydrate from private objects after restart", async () => {
  const metadata = memoryPersistence().stores.metadata;
  const bytes = Buffer.alloc(2 * 1024 * 1024, 42);
  const input = { ...request, inputFiles: Array.from({ length: 10 }, (_, i) => ({
    name: `image-${i}.png`, mimetype: "image/png", sizeBytes: bytes.length, dataBase64: bytes.toString("base64"),
  })) };
  const objects = new Map<string, Uint8Array>();
  const storage = {
    async put({ key, bytes }: { key: string; bytes: Uint8Array }) { objects.set(key, bytes); },
    async get(key: string) { const value = objects.get(key); assert.ok(value); return value; },
  };
  await new NativeT3RunRequestStore(metadata, storage).saveRequest(input);
  const persisted = JSON.stringify(await metadata.get("compadre.t3.run-requests.v1", input.runId));
  assert.ok(persisted.length < 10_000);
  assert.ok(!persisted.includes("dataBase64"));
  assert.ok(persisted.includes("attachments/native-inputs/v1/"));
  assert.equal(objects.size, 1, "identical bytes share an immutable object within a run");
  const restored = new NativeT3RunRequestStore(metadata, storage);
  assert.deepEqual(await restored.getRequest(input.runId), input);
  objects.clear();
  assert.deepEqual((await restored.getRequest(input.runId, { includeInputFiles: false }))?.inputFiles, []);
  assert.equal(JSON.stringify(await metadata.get("compadre.t3.run-requests.v1", input.runId)), persisted);
});

test("failed or unconfigured uploads never fall back to database bytes", async () => {
  const metadata = memoryPersistence().stores.metadata;
  const input = { ...request, inputFiles: [{ name: "x.png", mimetype: "image/png", sizeBytes: 1, dataBase64: "eA==" }] };
  await assert.rejects(new NativeT3RunRequestStore(metadata).saveRequest(input), /not configured/);
  await assert.rejects(new NativeT3RunRequestStore(metadata, {
    async put() { throw new Error("S3 unavailable"); }, async get() { throw new Error("unused"); },
  }).saveRequest(input), /S3 unavailable/);
  assert.equal(await metadata.get("compadre.t3.run-requests.v1", input.runId), null);
});

test("inline records require migration and corrupt object bytes are rejected", async () => {
  const metadata = memoryPersistence().stores.metadata;
  const input = { ...request, inputFiles: [{ name: "x.png", mimetype: "image/png", sizeBytes: 1, dataBase64: "eA==" }] };
  await metadata.set("compadre.t3.run-requests.v1", input.runId, input);
  await assert.rejects(new NativeT3RunRequestStore(metadata).getRequest(input.runId), /migrate inline/);
  const store = new NativeT3RunRequestStore(metadata, { async put() {}, async get() { return Buffer.from("y"); } });
  await store.saveRequest(input);
  await assert.rejects(store.getRequest(input.runId), /integrity/);
});
