import assert from "node:assert/strict";
import test from "node:test";
import { memoryPersistence } from "@tanstack/ai-persistence";
import { InMemoryLockStore } from "../t3/storage.js";
import { log } from "../logging.js";
import {
  PreviewActivationService,
  PreviewActivationStore,
} from "./preview-activation.js";

test("concurrent preview starts reuse one durable activation", async () => {
  const persistence = memoryPersistence();
  const store = new PreviewActivationStore(
    persistence.stores.metadata,
    () => new Date("2026-09-03T12:00:00.000Z"),
  );
  const launches: string[] = [];
  const service = new PreviewActivationService(
    store,
    new InMemoryLockStore(),
    {
      start: async (input) => {
        launches.push(input.activationId);
      },
    },
    () => "activation-1",
  );

  const [first, second] = await Promise.all([
    service.start("thread-1"),
    service.start("thread-1"),
  ]);

  assert.equal(first.activationId, "activation-1");
  assert.equal(second.activationId, "activation-1");
  assert.deepEqual(launches, ["activation-1", "activation-1"]);
});

test("a failed preview activation can start a fresh attempt", async () => {
  const persistence = memoryPersistence();
  const store = new PreviewActivationStore(persistence.stores.metadata);
  const ids = ["activation-1", "activation-2"];
  const service = new PreviewActivationService(
    store,
    new InMemoryLockStore(),
    { start: async () => undefined },
    () => ids.shift()!,
  );

  const first = await service.start("thread-1");
  await store.update(
    "thread-1",
    first.activationId,
    "failed",
    "startup failed",
  );
  const second = await service.start("thread-1");

  assert.equal(first.activationId, "activation-1");
  assert.equal(second.activationId, "activation-2");
  assert.equal((await service.status("thread-1"))?.phase, "requested");
});

test("stale workflow updates cannot overwrite a newer activation", async () => {
  const persistence = memoryPersistence();
  const store = new PreviewActivationStore(persistence.stores.metadata);
  await store.create("thread-1", "activation-2");

  const stale = await store.update(
    "thread-1",
    "activation-1",
    "failed",
    "late",
  );

  assert.equal(stale, null);
  assert.equal((await store.get("thread-1"))?.activationId, "activation-2");
});

test("measures queue, restore, and startup across store recreation and duplicate delivery", async (t) => {
  const entries: Record<string, unknown>[] = [];
  t.mock.method(log, "info", (entry: Record<string, unknown>) => entries.push(entry));
  const persistence = memoryPersistence();
  const base = Date.parse("2026-09-23T12:00:00Z");
  let elapsed = 0;
  const now = () => new Date(base + elapsed);
  let store = new PreviewActivationStore(persistence.stores.metadata, now);
  await store.create("thread-1", "activation-1");
  elapsed = 10_000;
  await store.update("thread-1", "activation-1", "restoring");
  elapsed = 15_000;
  await store.update("thread-1", "activation-1", "restoring");
  assert.equal((await store.get("thread-1"))?.updatedAt, new Date(base + 10_000).toISOString());

  store = new PreviewActivationStore(persistence.stores.metadata, now);
  elapsed = 40_000;
  await store.update("thread-1", "activation-1", "starting");
  elapsed = 100_000;
  await store.update("thread-1", "activation-1", "ready");
  elapsed = 110_000;
  await store.update("thread-1", "activation-1", "ready");
  await store.update("thread-1", "activation-1", "restoring");
  await store.update("thread-1", "stale-activation", "failed");
  assert.equal((await store.get("thread-1"))?.phase, "ready");
  assert.deepEqual(entries.filter((entry) => entry.event === "preview.activation.transition")
    .map(({ previousPhase, phase, phaseDurationMs, elapsedMs }) => ({ previousPhase, phase, phaseDurationMs, elapsedMs })), [
    { previousPhase: "requested", phase: "restoring", phaseDurationMs: 10_000, elapsedMs: 10_000 },
    { previousPhase: "restoring", phase: "starting", phaseDurationMs: 30_000, elapsedMs: 40_000 },
    { previousPhase: "starting", phase: "ready", phaseDurationMs: 60_000, elapsedMs: 100_000 },
  ]);
});

test("failed activations include retries in total time without logging failure contents", async (t) => {
  const entries: Record<string, unknown>[] = [];
  t.mock.method(log, "info", (entry: Record<string, unknown>) => entries.push(entry));
  const persistence = memoryPersistence();
  let elapsed = 0;
  const store = new PreviewActivationStore(persistence.stores.metadata, () => new Date(elapsed));
  await store.create("thread-1", "activation-1");
  elapsed = 1_000;
  await store.update("thread-1", "activation-1", "restoring");
  elapsed = 2_000;
  await store.update("thread-1", "activation-1", "starting");
  elapsed = 4_000;
  await store.update("thread-1", "activation-1", "restoring");
  elapsed = 8_000;
  await store.update("thread-1", "activation-1", "failed", "private failure details");
  assert.equal(entries.at(-1)?.elapsedMs, 8_000);
  assert.equal(entries.at(-1)?.phaseDurationMs, 4_000);
  assert.equal(JSON.stringify(entries).includes("private failure details"), false);
});

test("legacy activations remain readable without inventing a total startup duration", async (t) => {
  const entries: Record<string, unknown>[] = [];
  t.mock.method(log, "info", (entry: Record<string, unknown>) => entries.push(entry));
  const persistence = memoryPersistence();
  await persistence.stores.metadata.set("compadre.t3.preview-activations.v1", "thread-1", {
    canonicalThreadId: "thread-1",
    activationId: "activation-old",
    phase: "starting",
    updatedAt: new Date(1_000).toISOString(),
  });
  const store = new PreviewActivationStore(persistence.stores.metadata, () => new Date(5_000));
  const record = await store.update("thread-1", "activation-old", "ready");
  assert.equal(record?.requestedAt, undefined);
  assert.equal(entries[0]?.phaseDurationMs, 4_000);
  assert.equal(entries[0]?.elapsedMs, undefined);
});
