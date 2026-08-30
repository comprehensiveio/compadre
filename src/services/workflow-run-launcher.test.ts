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

test("cancels an active workflow by durable run ID", async () => {
  let observedSignal: AbortSignal | undefined;
  const launcher = createLocalWorkflowRunLauncher(
    async (_input, _dependencies, signal) => {
      observedSignal = signal;
      if (signal?.aborted) throw signal.reason;
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
      throw new Error("unreachable");
    },
  );
  const started = await launcher.start({ prompt: "hi", runId: "run-1" });

  assert.equal(await launcher.cancelRun?.("run-1"), true);
  assert.ok(launcher.wait);
  await assert.rejects(launcher.wait(started.taskRunId));
  assert.equal(observedSignal?.aborted, true);
  assert.equal(await launcher.cancelRun?.("run-1"), false);
});
