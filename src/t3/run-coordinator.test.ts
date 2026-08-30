import assert from "node:assert/strict";
import test from "node:test";
import { replayRunStream } from "@tanstack/ai";
import { createAgentRunDurability } from "../durability/runtime.js";
import { EventType } from "./agui-protocol.js";
import { NativeT3RunCoordinator } from "./run-coordinator.js";
import type { LockStore } from "./storage.js";

async function memoryCoordinator() {
  const durability = await createAgentRunDurability({
    COMPADRE_DURABILITY_BACKEND: "memory",
  });
  assert.ok(durability);
  return {
    durability,
    coordinator: new NativeT3RunCoordinator(durability),
  };
}

async function events(
  coordinator: NativeT3RunCoordinator,
  runId: string,
) {
  const output: Array<Record<string, unknown>> = [];
  for await (const event of replayRunStream(coordinator.stream(runId), "-1")) {
    output.push(event as unknown as Record<string, unknown>);
  }
  return output;
}

test("persists native T3 events independently of any subscriber", async (t) => {
  const { durability, coordinator } = await memoryCoordinator();
  t.after(() => durability.close());
  let release!: () => void;
  const gated = new Promise<void>((resolve) => { release = resolve; });

  const started = await coordinator.start({
    runId: "native-run-1",
    threadId: "thread-1",
    async *source() {
      yield {
        type: EventType.RUN_STARTED,
        runId: "native-run-1",
        threadId: "thread-1",
      };
      await gated;
      yield {
        type: EventType.RUN_FINISHED,
        runId: "native-run-1",
        threadId: "thread-1",
      };
    },
    async cancel() {},
  });
  assert.equal(started.started, true);

  release();
  const replayed = await events(coordinator, "native-run-1");
  assert.deepEqual(replayed.map((event) => event.type), [
    EventType.RUN_STARTED,
    EventType.RUN_FINISHED,
  ]);
  assert.ok(replayed.every((event) => event.protocolVersion === 2));
  assert.equal((await coordinator.run("native-run-1"))?.status, "completed");
});

test("a repeated native run id replays one execution instead of starting another", async (t) => {
  const { durability, coordinator } = await memoryCoordinator();
  t.after(() => durability.close());
  let executions = 0;
  const input = {
    runId: "native-idempotent-run",
    threadId: "thread-1",
    async *source() {
      executions += 1;
      yield {
        type: EventType.RUN_FINISHED,
        runId: "native-idempotent-run",
        threadId: "thread-1",
      };
    },
    async cancel() {},
  };

  const [first, second] = await Promise.all([
    coordinator.start(input),
    coordinator.start(input),
  ]);
  await events(coordinator, input.runId);

  assert.deepEqual(
    [first.started, second.started].sort(),
    [false, true],
  );
  assert.equal(executions, 1);
});

test("releases the distributed start lock while provider runs are active", async (t) => {
  const durability = await createAgentRunDurability({
    COMPADRE_DURABILITY_BACKEND: "memory",
  });
  assert.ok(durability);
  t.after(() => durability.close());

  let heldLocks = 0;
  let peakLocks = 0;
  const locks: LockStore = {
    async withLock(_key, operation) {
      heldLocks += 1;
      peakLocks = Math.max(peakLocks, heldLocks);
      try {
        return await operation(new AbortController().signal);
      } finally {
        heldLocks -= 1;
      }
    },
  };
  const coordinator = new NativeT3RunCoordinator(durability, locks);
  let release!: () => void;
  const gated = new Promise<void>((resolve) => { release = resolve; });
  const runIds = Array.from({ length: 8 }, (_, index) => `concurrent-${index}`);

  await Promise.all(runIds.map((runId) => coordinator.start({
    runId,
    threadId: `thread-${runId}`,
    async *source() {
      yield {
        type: EventType.RUN_STARTED,
        runId,
        threadId: `thread-${runId}`,
      };
      await gated;
      yield {
        type: EventType.RUN_FINISHED,
        runId,
        threadId: `thread-${runId}`,
      };
    },
    async cancel() {},
  })));

  assert.ok(peakLocks > 0);
  assert.equal(heldLocks, 0, "active provider runs must not retain lock-pool clients");

  release();
  await Promise.all(runIds.map((runId) => events(coordinator, runId)));
  assert.equal(heldLocks, 0);
});

test("cancel records durable intent and invokes the active worker fast path", async (t) => {
  const { durability, coordinator } = await memoryCoordinator();
  t.after(() => durability.close());
  let cancelled = 0;

  await coordinator.start({
    runId: "native-cancel-run",
    threadId: "thread-1",
    async *source(signal) {
      yield {
        type: EventType.RUN_STARTED,
        runId: "native-cancel-run",
        threadId: "thread-1",
      };
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    async cancel() { cancelled += 1; },
  });

  const result = await coordinator.cancel("native-cancel-run");
  assert.deepEqual(result, {
    found: true,
    requested: true,
    local: true,
    status: "running",
  });
  assert.equal(cancelled, 1);
  assert.equal((await coordinator.run("native-cancel-run"))?.cancelRequested, true);
  await events(coordinator, "native-cancel-run");
  assert.equal((await coordinator.run("native-cancel-run"))?.status, "aborted");
});
