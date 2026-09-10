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

test("orders by activity, regardless of health, and explains the active tool", async () => {
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
        lastActiveAt: "2026-08-31T17:59:00.000Z",
      }),
      binding("thread-stuck", {
        activeRunId: "run-stuck",
        status: "working",
        updatedAt: "2026-08-31T17:29:00.000Z",
        lastActiveAt: "2026-08-31T17:29:00.000Z",
      }),
    ],
    durability,
    now: NOW,
  });

  assert.equal(snapshot.threads[1]?.canonicalThreadId, "thread-stuck");
  assert.equal(snapshot.threads[1]?.phase, "Using Bash: select count(*) from a very large table");
  assert.equal(snapshot.threads[1]?.health, "stuck");
  assert.equal(snapshot.threads[1]?.activeRun?.driverEpoch, 3);
  assert.equal(snapshot.threads[1]?.container.status, "running");
  assert.equal(snapshot.threads[0]?.container.status, "stopped");
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

test("shows generating, waiting, resumed tool work and terminal state without stale activity", async () => {
  const durability = await createAgentRunDurability({ COMPADRE_DURABILITY_BACKEND: "memory" });
  assert.ok(durability);
  await durability.runs.createOrResume({ runId: "activity", threadId: "thread", startedAt: NOW.getTime() });
  const current = binding("thread", { status: "working", activeRunId: "activity" });
  const read = async (override: Partial<T3ThreadBinding> = {}) => (await buildT3ThreadOperationsSnapshot({ bindings: [{ ...current, ...override }], durability, now: NOW })).threads[0]!;
  await durability.stream("activity").append([{ type: "TEXT_MESSAGE_START", timestamp: NOW.getTime() } as never]);
  assert.equal((await read()).phase, "Generating response");
  assert.equal((await read()).activitySince, NOW.toISOString());
  await durability.stream("activity").append([
    { type: "TOOL_CALL_START", toolCallId: "tool", toolCallName: "Bash", timestamp: NOW.getTime() } as never,
    { type: "COMPADRE_AGENT_ACTIVITY", status: "approval.requested", timestamp: NOW.getTime() } as never,
  ]);
  assert.equal((await read()).phase, "Waiting for approval");
  await durability.stream("activity").append([{ type: "COMPADRE_AGENT_ACTIVITY", status: "approval.resolved", timestamp: NOW.getTime() } as never]);
  assert.equal((await read()).phase, "Using Bash");
  assert.equal((await read({ status: "error" })).phase, "Failed");
  assert.equal((await read({ status: "ready", activeRunId: undefined })).phase, "Idle");
});


test("operations reads native progress and pending choices from central storage without transcript receipts", async () => {
  const durability = await createAgentRunDurability({ COMPADRE_DURABILITY_BACKEND: "memory" });
  assert.ok(durability);
  await durability.runs.createOrResume({ runId: "native", threadId: "thread", startedAt: NOW.getTime() - 40 * 60_000 });
  await durability.stream("native").append([{ type: "RUN_STARTED", timestamp: NOW.getTime() - 40 * 60_000 } as never]);
  const activities = [
    { id: "tool", kind: "tool.started", summary: "Command run started", payload: { toolCallId: "shell" }, turnId: "turn", createdAt: NOW.toISOString() },
    { id: "question", kind: "user-input.requested", summary: "Choose a value", payload: { requestId: "choice" }, turnId: "turn", createdAt: NOW.toISOString() },
  ];
  let reads = 0;
  const read = async () => (await buildT3ThreadOperationsSnapshot({
    bindings: [binding("thread", { status: "working", activeRunId: "native" }), binding("idle")], durability, now: NOW,
    async readCentralSnapshot(threadId) {
      assert.equal(threadId, "thread"); reads += 1;
      return { snapshotSequence: 20, thread: { id: threadId, projectId: "project", title: "Native",
        modelSelection: { instanceId: "codex", model: "test" }, latestTurn: null, messages: [], activities,
        session: { status: "running", activeTurnId: "turn", lastError: null } } };
    },
  })).threads.find(thread => thread.canonicalThreadId === "thread")!;
  const waiting = await read();
  assert.equal(waiting.phase, "Waiting for your input");
  assert.equal(waiting.health, "healthy");
  assert.equal(waiting.activeRun?.idleMs, 0);
  assert.equal(waiting.recentEvents?.at(-1)?.type, "user-input.requested");
  activities.push({ ...activities[1]!, id: "answer", kind: "user-input.resolved" });
  assert.equal((await read()).phase, "Command run started");
  assert.equal(reads, 2, "idle threads never need a central snapshot or a worker read");
});
