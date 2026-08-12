import assert from "node:assert/strict";
import test from "node:test";
import {
  createConfiguredWorkflowRunLauncher,
  createLocalWorkflowRunLauncher,
} from "./workflow-run-launcher.js";

test("uses the database-free in-process runner by default", () => {
  assert.doesNotThrow(() => createConfiguredWorkflowRunLauncher({}));
});

test("requires an explicit Workflow slug for the Render runner", () => {
  assert.throws(
    () =>
      createConfiguredWorkflowRunLauncher({
        COMPADRE_WORKFLOW_RUNNER: "render",
      }),
    /COMPADRE_RENDER_WORKFLOW_SLUG/,
  );
});

test("lets a concurrent local waiter observe task completion", async () => {
  const launcher = createLocalWorkflowRunLauncher(async () => ({}) as never);
  const started = await launcher.start({ prompt: "hi" });
  await launcher.wait?.(started.taskRunId);
});
