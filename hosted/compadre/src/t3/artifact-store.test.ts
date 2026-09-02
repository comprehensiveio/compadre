import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { memoryPersistence } from "@tanstack/ai-persistence";
import {
  T3ArtifactStore,
  t3ArtifactObjectKey,
  type T3ArtifactObjectStore,
} from "./artifact-store.js";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("stores content-addressed T3 artifacts outside Postgres", async () => {
  const objects = new Map<string, Uint8Array>();
  const objectStore: T3ArtifactObjectStore = {
    async put({ key, bytes }) { objects.set(key, bytes); },
    async get(key) {
      const bytes = objects.get(key);
      if (!bytes) throw new Error("missing object");
      return bytes;
    },
    async check() {},
  };
  const bytes = Uint8Array.from([1, 2, 3]);
  const artifactId = digest(bytes);
  const store = new T3ArtifactStore(
    objectStore,
    memoryPersistence().stores.metadata,
    () => new Date("2026-08-29T12:00:00.000Z"),
  );
  const metadata = await store.publish({
    runId: "run/unsafe",
    artifactId,
    path: "reports/result.bin",
    name: "result.bin",
    title: "reports/result.bin",
    mimetype: "application/octet-stream",
    bytes,
  });
  assert.equal(metadata.objectKey, t3ArtifactObjectKey("run/unsafe", artifactId));
  assert.match(metadata.objectKey, /^attachments\/v1\//);
  assert.doesNotMatch(metadata.objectKey, /run\/unsafe/);
  assert.deepEqual(await store.read("run/unsafe", artifactId), { metadata, bytes });
});

test("rejects mismatched and corrupted artifact bytes", async () => {
  let objectBytes: Uint8Array = Uint8Array.from([1, 2, 3]);
  const objectStore: T3ArtifactObjectStore = {
    async put({ bytes }) { objectBytes = bytes; },
    async get() { return objectBytes; },
    async check() {},
  };
  const store = new T3ArtifactStore(objectStore, memoryPersistence().stores.metadata);
  await assert.rejects(
    store.publish({
      runId: "run-1",
      artifactId: "a".repeat(64),
      path: "file",
      name: "file",
      title: "file",
      mimetype: "text/plain",
      bytes: Uint8Array.from([1]),
    }),
    /do not match/,
  );
});
