import assert from "node:assert/strict";
import test from "node:test";
import { createConfiguredWorkflowRunLauncher } from "./workflow-run-launcher.js";

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
