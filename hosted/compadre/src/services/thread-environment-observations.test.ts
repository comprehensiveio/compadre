import assert from "node:assert/strict";
import test from "node:test";
import {
  createEnvironmentObserver,
  type ThreadEnvironmentObservation,
} from "./thread-environment-observations.js";
import type { T3ThreadBinding } from "./t3-thread-bindings.js";

const binding = {
  canonicalThreadId: "thread",
  sandboxId: "sb-1",
  workerState: "running",
  workerGeneration: 1,
} as T3ThreadBinding;
const ready = {
  container: "running",
  devServer: "ready",
  database: "ready",
  checkedAt: "2026-09-05T12:00:00Z",
} as const;

test("never inspects suspended or transitioning workers", () => {
  const observe = createEnvironmentObserver(async () => {
    assert.fail("must not connect");
  });
  for (const workerState of [
    "suspended",
    "restoring",
    "hibernating",
  ] as const) {
    const value = observe([{ ...binding, workerState }]).get("thread");
    assert.equal(
      value?.container,
      workerState === "suspended" ? "stopped" : "unknown",
    );
  }
});

test("returns cached observations without blocking; isolates generations and caps concurrency", async () => {
  let finish!: (value: ThreadEnvironmentObservation) => void;
  let calls = 0;
  const promise = new Promise<ThreadEnvironmentObservation>((resolve) => {
    finish = resolve;
  });
  const observe = createEnvironmentObserver(() => {
    calls++;
    return promise;
  });
  const bindings = Array.from({ length: 8 }, (_, i) => ({
    ...binding,
    canonicalThreadId: `thread-${i}`,
    sandboxId: `sb-${i}`,
  }));
  assert.equal(observe(bindings).get("thread-0")?.container, "unknown");
  observe(bindings);
  assert.equal(calls, 4);
  finish(ready);
  await promise;
  await Promise.resolve();
  assert.equal(observe(bindings).get("thread-0")?.devServer, "ready");
  assert.equal(
    observe([{ ...bindings[0]!, workerGeneration: 2 }]).get("thread-0")
      ?.devServer,
    "unknown",
  );
});

test("a failed check becomes unknown and a later refresh recovers", async () => {
  let currentTime = 0;
  let fail = true;
  const observe = createEnvironmentObserver(
    async () => {
      if (fail) throw new Error("Modal unavailable");
      return ready;
    },
    () => currentTime,
  );
  observe([binding]);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(observe([binding]).get("thread")?.container, "unknown");
  fail = false;
  currentTime = 31_000;
  observe([binding]);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(observe([binding]).get("thread")?.container, "running");
});
