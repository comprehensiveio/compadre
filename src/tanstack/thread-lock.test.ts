import assert from "node:assert/strict";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import test from "node:test";
import { InMemoryLockStore } from "@tanstack/ai/locks";
import { ThreadRunCoordinator } from "./thread-lock.js";

test("serializes complete runs for the same thread", async () => {
  const coordinator = new ThreadRunCoordinator(new InMemoryLockStore());
  const first = await coordinator.acquire("thread-1");
  let secondAcquired = false;
  const secondPromise = coordinator.acquire("thread-1").then((lease) => {
    secondAcquired = true;
    return lease;
  });

  await waitForImmediate();
  assert.equal(secondAcquired, false);

  await first.release();
  const second = await secondPromise;
  assert.equal(secondAcquired, true);
  await second.release();
});

test("allows different threads to run concurrently", async () => {
  const coordinator = new ThreadRunCoordinator(new InMemoryLockStore());
  const first = await coordinator.acquire("thread-1");
  const second = await coordinator.acquire("thread-2");

  await Promise.all([first.release(), second.release()]);
});
