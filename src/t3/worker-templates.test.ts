import assert from "node:assert/strict";
import test from "node:test";
import type { MetadataStore } from "./storage.js";
import {
  clearWorkerTemplate,
  publishWorkerTemplate,
  readWorkerTemplate,
} from "./worker-templates.js";

function memoryMetadata(): MetadataStore {
  const data = new Map<string, unknown>();
  return {
    async get(namespace, key) {
      const value = data.get(`${namespace}:${key}`);
      return value === undefined ? null : value;
    },
    async set(namespace, key, value) {
      data.set(`${namespace}:${key}`, JSON.parse(JSON.stringify(value)));
    },
    async delete(namespace, key) {
      data.delete(`${namespace}:${key}`);
    },
  };
}

test("round-trips, validates, and clears the worker template pointer", async () => {
  const metadata = memoryMetadata();
  assert.equal(await readWorkerTemplate(metadata), null);

  const template = {
    snapshotId: "im-template-1",
    repoSha: "abc123",
    backupKey: "hourly/db-backup.sql.gz",
    builtAt: "2026-09-01T00:00:00.000Z",
  };
  await publishWorkerTemplate(metadata, template);
  assert.deepEqual(await readWorkerTemplate(metadata), template);

  await clearWorkerTemplate(metadata);
  assert.equal(await readWorkerTemplate(metadata), null);
});

test("a malformed pointer reads as no template (cold build)", async () => {
  const metadata = memoryMetadata();
  await metadata.set("compadre.t3.worker-template.v1", "current", {
    snapshotId: "   ",
  });
  assert.equal(await readWorkerTemplate(metadata), null);
});
