import assert from "node:assert/strict";
import test from "node:test";
import { createAgentRunDurability } from "../durability/runtime.js";
import type { T3ThreadBinding } from "./t3-thread-bindings.js";
import { buildT3ThreadOperationsSnapshot } from "./t3-thread-operations.js";

const NOW = new Date("2026-08-31T18:00:00.000Z");

function binding(
  canonicalThreadId: string,
  overrides: Partial<T3ThreadBinding> = {},
): T3ThreadBinding {
  return {
    canonicalThreadId,
    providerInstanceId: "codex",
    t3ThreadId: `worker-${canonicalThreadId}`,
    projectId: "project-1",
    sandboxId: `sandbox-${canonicalThreadId}`,
    baseUrl: "https://worker.invalid",
    workerState: "running",
    workerGeneration: 2,
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    title: canonicalThreadId,
    status: "ready",
    createdAt: "2026-08-31T16:00:00.000Z",
    updatedAt: "2026-08-31T17:59:00.000Z",
    ...overrides,
  };
}

test("orders stuck work first and explains its active tool and container", async () => {
  const durability = await createAgentRunDurability({
    COMPADRE_DURABILITY_BACKEND: "memory",
  });
  assert.ok(durability);
  await durability.runs.createOrResume({
    runId: "run-stuck",
    threadId: "thread-stuck",
    startedAt: NOW.getTime() - 31 * 60_000,
  });
  await durability.runs.update("run-stuck", { driverEpoch: 3 });
  await durability.stream("run-stuck").append([
    {
      type: "RUN_STARTED",
      runId: "run-stuck",
      threadId: "thread-stuck",
    } as never,
    {
      type: "TOOL_CALL_START",
      toolCallId: "tool-1",
      toolCallName: "Bash",
      detail: "select count(*) from a very large table",
    } as never,
  ]);

  const snapshot = await buildT3ThreadOperationsSnapshot({
    bindings: [
      binding("thread-ready", {
        workerState: "suspended",
        status: "ready",
      }),
      binding("thread-stuck", {
        activeRunId: "run-stuck",
        status: "working",
        updatedAt: "2026-08-31T17:29:00.000Z",
      }),
    ],
    durability,
    now: NOW,
  });

  assert.equal(snapshot.threads[0]?.canonicalThreadId, "thread-stuck");
  assert.equal(snapshot.threads[0]?.phase, "Using Bash: select count(*) from a very large table");
  assert.equal(snapshot.threads[0]?.health, "stuck");
  assert.equal(snapshot.threads[0]?.activeRun?.driverEpoch, 3);
  assert.equal(snapshot.threads[0]?.container.status, "running");
  assert.equal(snapshot.threads[1]?.container.status, "stopped");
  assert.deepEqual(snapshot.counts, {
    total: 2,
    working: 1,
    attention: 0,
    stuck: 1,
    containersRunning: 1,
  });
});

test("flags a working binding that never acquired a durable run marker", async () => {
  const durability = await createAgentRunDurability({
    COMPADRE_DURABILITY_BACKEND: "memory",
  });
  assert.ok(durability);
  const snapshot = await buildT3ThreadOperationsSnapshot({
    bindings: [
      binding("thread-no-run", {
        status: "working",
        updatedAt: "2026-08-31T17:45:00.000Z",
      }),
    ],
    durability,
    now: NOW,
  });
  assert.equal(snapshot.threads[0]?.health, "stuck");
  assert.equal(snapshot.threads[0]?.healthReason, "Working state has no durable run marker");
  assert.equal(snapshot.threads[0]?.phase, "Dispatching run");
});
