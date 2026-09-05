import assert from "node:assert/strict";
import test from "node:test";
import { createTemporalNativeT3WorkflowLauncher } from "./run-service.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test("Temporal cancellation waits for workflow cleanup before acknowledging", async () => {
  const cleanup = deferred<void>();
  let cancelCalled = false;
  const launcher = createTemporalNativeT3WorkflowLauncher(async () => ({
    workflow: {
      async start() {},
      getHandle() {
        return {
          async cancel() {
            cancelCalled = true;
          },
          result() {
            return cleanup.promise;
          },
          async executeUpdate<T>() {
            return true as T;
          },
        };
      },
    },
  }));

  let settled = false;
  const cancellation = launcher.cancel("native-run-1").then((value) => {
    settled = true;
    return value;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cancelCalled, true);
  assert.equal(settled, false, "cleanup is still saving the interrupted state");

  cleanup.resolve();
  assert.equal(await cancellation, true);
  assert.equal(settled, true);
});

test("Temporal steering uses an idempotent Workflow Update id", async () => {
  const updates: Array<{
    workflowId: string;
    name: string;
    updateId: string;
    input: { id: string; text: string };
  }> = [];
  const launcher = createTemporalNativeT3WorkflowLauncher(async () => ({
    workflow: {
      async start() {},
      getHandle(workflowId: string) {
        return {
          async cancel() {},
          async result() {},
          async executeUpdate<T>(
            name: string,
            options: {
              args: [{ id: string; text: string }];
              updateId: string;
            },
          ) {
            updates.push({
              workflowId,
              name,
              updateId: options.updateId,
              input: options.args[0],
            });
            return true as T;
          },
        };
      },
    },
  }));

  assert.equal(
    await launcher.steer("native-run-2", {
      id: "instruction-1",
      text: "focus on the tests",
    }),
    true,
  );
  assert.deepEqual(updates, [
    {
      workflowId: "native-run-2",
      name: "steerNativeT3Run",
      updateId: "instruction-1",
      input: { id: "instruction-1", text: "focus on the tests" },
    },
  ]);
});
