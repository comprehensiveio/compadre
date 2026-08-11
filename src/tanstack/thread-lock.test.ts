import assert from "node:assert/strict";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import test from "node:test";
import { InMemoryLockStore } from "@tanstack/ai/locks";
import {
  BackgroundCapacityPreemptedError,
  RunCapacityCoordinator,
  ThreadRunCoordinator,
} from "./thread-lock.js";

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

test("foreground work preempts background capacity", async () => {
  const capacity = new RunCapacityCoordinator(
    new ThreadRunCoordinator(new InMemoryLockStore()),
  );
  let backgroundStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    backgroundStarted = resolve;
  });

  const background = capacity.runBackground(
    (signal) =>
      new Promise<void>((_resolve, reject) => {
        backgroundStarted();
        signal.addEventListener(
          "abort",
          () => reject(signal.reason),
          { once: true },
        );
      }),
  );
  await started;

  const foreground = capacity.acquireForeground();
  assert.deepEqual(await background, { status: "preempted" });
  const lease = await foreground;
  assert.equal(lease.signal.aborted, false);
  await lease.release();
});

test("a background lease exposes foreground preemption to a streamed run", async () => {
  const capacity = new RunCapacityCoordinator(
    new ThreadRunCoordinator(new InMemoryLockStore()),
  );
  const background = await capacity.acquireBackground();
  assert.ok(background);

  const foreground = capacity.acquireForeground();
  assert.equal(background.signal.aborted, true);
  assert.ok(
    background.signal.reason instanceof BackgroundCapacityPreemptedError,
  );

  await background.release();
  const foregroundLease = await foreground;
  await foregroundLease.release();
});

test("a queued background lease yields when foreground work arrives", async () => {
  const capacity = new RunCapacityCoordinator(
    new ThreadRunCoordinator(new InMemoryLockStore()),
  );
  const active = await capacity.acquireForeground();
  const background = capacity.acquireBackground();
  const foreground = capacity.acquireForeground();

  await active.release();
  assert.equal(await background, undefined);
  const foregroundLease = await foreground;
  await foregroundLease.release();
});

test("background capacity preserves non-preemption failures", async () => {
  const capacity = new RunCapacityCoordinator(
    new ThreadRunCoordinator(new InMemoryLockStore()),
  );

  await assert.rejects(
    capacity.runBackground(async () => {
      throw new Error("setup failed");
    }),
    /setup failed/,
  );
});
