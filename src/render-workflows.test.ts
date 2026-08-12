import assert from "node:assert/strict";
import test from "node:test";
import type { TaskRunDetails } from "@renderinc/sdk/workflows";
import { waitForTaskRun } from "./render-workflows.js";

function run(status: TaskRunDetails["status"]): TaskRunDetails {
  return {
    id: "run-1",
    taskId: "task-1",
    status,
    results: [],
    input: [],
    parentTaskRunId: "run-1",
    rootTaskRunId: "run-1",
    retries: 0,
    attempts: [],
  };
}

test("polls until a Workflow task reaches a terminal state", async () => {
  const statuses: TaskRunDetails["status"][] = [
    "pending",
    "running",
    "completed",
  ];
  const sleeps: number[] = [];
  const result = await waitForTaskRun(
    { getTaskRun: async () => run(statuses.shift()!) },
    "run-1",
    {
      sleep: async (durationMs) => void sleeps.push(durationMs),
    },
  );

  assert.equal(result.status, "completed");
  assert.deepEqual(sleeps, [1_000, 1_000]);
});

test("returns failed Workflow tasks instead of waiting forever", async () => {
  const result = await waitForTaskRun(
    { getTaskRun: async () => run("failed") },
    "run-1",
  );
  assert.equal(result.status, "failed");
});

test("times out with the last observed status", async () => {
  let now = 0;
  await assert.rejects(
    waitForTaskRun(
      { getTaskRun: async () => run("running") },
      "run-1",
      {
        timeoutMs: 2_000,
        now: () => now,
        sleep: async (durationMs) => void (now += durationMs),
      },
    ),
    /Timed out.*last status: running/,
  );
});

test("tolerates bounded transient task-status read failures", async () => {
  let attempts = 0;
  const result = await waitForTaskRun(
    {
      getTaskRun: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("temporary Render API failure");
        return run("completed");
      },
    },
    "run-1",
    { sleep: async () => undefined },
  );

  assert.equal(result.status, "completed");
  assert.equal(attempts, 3);
});

test("fails after the configured consecutive task-status read limit", async () => {
  await assert.rejects(
    waitForTaskRun(
      {
        getTaskRun: async () => {
          throw new Error("Render API unavailable");
        },
      },
      "run-1",
      { maxConsecutiveReadErrors: 1, sleep: async () => undefined },
    ),
    /Render API unavailable/,
  );
});

test("honors aborts before polling", async () => {
  const controller = new AbortController();
  controller.abort(new Error("probe canceled"));
  await assert.rejects(
    waitForTaskRun({ getTaskRun: async () => run("running") }, "run-1", {
      signal: controller.signal,
    }),
    /probe canceled/,
  );
});
