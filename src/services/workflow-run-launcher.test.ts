import assert from "node:assert/strict";
import test from "node:test";
import {
  createConfiguredWorkflowRunLauncher,
  createLocalWorkflowRunLauncher,
} from "./workflow-run-launcher.js";

test("always uses the in-process controller", () => {
  assert.doesNotThrow(() => createConfiguredWorkflowRunLauncher());
});

test("lets a concurrent local waiter observe task completion", async () => {
  const launcher = createLocalWorkflowRunLauncher(async () => ({}) as never);
  const started = await launcher.start({ prompt: "hi" });
  await launcher.wait?.(started.taskRunId);
});
