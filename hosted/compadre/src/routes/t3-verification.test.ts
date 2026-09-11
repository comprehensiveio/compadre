import { devBackupAccessProjection } from "../t3/dev-backups.js";
import assert from "node:assert/strict";
import test from "node:test";
import { memoryPersistence } from "@tanstack/ai-persistence";
import { createT3VerificationRoutes } from "./t3-verification.js";
import { T3VerificationStore } from "../t3/verification.js";
import { InMemoryLockStore } from "../t3/storage.js";
import type { T3ThreadSnapshot } from "../t3/client.js";

test("verification is key-protected, canary-only, and uses central commands and projections", async (t) => {
  const previous = process.env.COMPADRE_API_KEY;
  process.env.COMPADRE_API_KEY = "verification-key";
  t.after(() => { if (previous === undefined) delete process.env.COMPADRE_API_KEY; else process.env.COMPADRE_API_KEY = previous; });
  const store = new T3VerificationStore(memoryPersistence().stores.metadata, new InMemoryLockStore());
  const calls: string[] = [];
  const snapshot: T3ThreadSnapshot = { snapshotSequence: 10, thread: { id: "", projectId: "project", title: "Verification",
    modelSelection: { instanceId: "codex", model: "test-model" }, latestTurn: null, messages: [], session: null } };
  const app = createT3VerificationRoutes({ enabled: () => true, resources: async () => ({
    store, central: {
      async snapshot() { return { snapshotSequence: 10, projects: [], threads: [], updatedAt: "2026-09-11T00:00:00.000Z" }; },
      async createThread(input) { calls.push("create"); snapshot.thread.id = input.threadId!; return input.threadId!; },
      async threadSnapshot() { calls.push("read"); return snapshot; },
      async startTurn(input) { calls.push("turn"); return { sequence: 11, commandId: input.commandId!, messageId: input.messageId!, threadId: input.threadId, createdAt: new Date().toISOString() }; },
      async stopSession() { calls.push("stop"); return 12; },
    },
    delivery: { async get(threadId) { return { version: 1, canonicalThreadId: threadId, sourceThreadId: "worker", sandboxId: "sandbox", epoch: 1,
      offset: "00000000000000000010", startOffset: "00000000000000000000", checkpointOffset: 0 }; } },
    runs: { async run() { return null; }, async activeRun() { return null; }, async cancel() { return { found: false, requested: false, local: false }; } },
    async latestRun() { return { runId: "completed-before-binding", threadId: snapshot.thread.id, status: "failed", startedAt: 1 }; },
    async requestStorage() { return null; },
    async workflow(_thread, _epoch, action) { calls.push(action ?? "workflow-read"); return { status: "FAILED" }; },
  }) });
  const base = "/internal/operations/verification";
  const headers = { authorization: "Bearer verification-key", "content-type": "application/json" };
  for (const [method, path] of [["GET", base], ["POST", base], ["GET", `${base}/ordinary`], ["POST", `${base}/ordinary/turn`], ["POST", `${base}/ordinary/resume-delivery`], ["POST", `${base}/ordinary/stop`]]) {
    assert.equal((await app.request(path!, { method })).status, 401);
  }
  assert.equal(calls.length, 0);
  const discovery = await app.request(base, { headers });
  assert.equal(discovery.status, 200);
  assert.ok((await discovery.json() as { scenarios: string[] }).scenarios.includes("delivery-ack-lost"));
  const created = await app.request(base, { method: "POST", headers, body: JSON.stringify({ projectId: "project", modelSelection: snapshot.thread.modelSelection }) });
  assert.equal(created.status, 201);
  const { threadId } = await created.json() as { threadId: string };
  assert.ok(threadId.startsWith("c0decafe-"));
  assert.doesNotThrow(() => devBackupAccessProjection({
    COMPADRE_DEV_ENVIRONMENT_ENABLED: "true", COMPADRE_DEV_PRODUCTION_DATA_ENABLED: "true",
    COMPADRE_CANONICAL_THREAD_ID: threadId, COMPADRE_DEV_BACKUP_ACCESS_SECRET: "test-secret",
    COMPADRE_PUBLIC_URL: "https://controller.example",
  }));
  for (const path of ["ordinary", "c0decafe-0000-4000-8000-000000000002", "ordinary/turn", "ordinary/resume-delivery", "ordinary/stop"]) {
    assert.equal((await app.request(`${base}/${path}`, { method: path.includes("/") ? "POST" : "GET", headers })).status, 404);
  }
  const turn = await app.request(`${base}/${threadId}/turn`, { method: "POST", headers, body: JSON.stringify({ messageId: "probe-1", scenario: "delivery-ack-lost" }) });
  assert.equal(turn.status, 202);
  assert.equal((await store.get(threadId))?.scenario, "delivery-ack-lost");
  const read = await app.request(`${base}/${threadId}`, { headers });
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("cache-control"), "no-store");
  const inspected = await read.json() as { central: T3ThreadSnapshot; run: { runId: string } };
  assert.equal(inspected.central.snapshotSequence, 10);
  assert.equal(inspected.run.runId, "completed-before-binding");
  assert.equal((await app.request(`${base}/${threadId}/resume-delivery`, { method: "POST", headers })).status, 202);
  assert.equal((await store.get(threadId))?.remaining, 0);
  assert.equal((await app.request(`${base}/${threadId}/stop`, { method: "POST", headers })).status, 200);
  assert.ok(calls.includes("create") && calls.includes("turn") && calls.includes("resume") && calls.includes("cancel") && calls.includes("stop"));
});
