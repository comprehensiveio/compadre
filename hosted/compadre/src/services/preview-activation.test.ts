import assert from "node:assert/strict";
import test from "node:test";
import { memoryPersistence } from "@tanstack/ai-persistence";
import { InMemoryLockStore } from "../t3/storage.js";
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
