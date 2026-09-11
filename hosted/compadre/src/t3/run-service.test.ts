import assert from "node:assert/strict";
import test from "node:test";
import { createTemporalNativeT3WorkflowLauncher, TemporalNativeT3RunService } from "./run-service.js";
import { NativeT3RunCoordinator } from "./run-coordinator.js";
import { NativeT3RunRequestStore, type NativeT3RunRequest } from "./run-request-store.js";
import { createAgentRunDurability } from "../durability/runtime.js";
import { memoryPersistence } from "@tanstack/ai-persistence";

test("request persistence failure never advertises a running run or launches work", async () => {
  const durability = await createAgentRunDurability({ COMPADRE_DURABILITY_BACKEND: "memory" });
  assert.ok(durability);
  let launches = 0;
  const metadata = memoryPersistence().stores.metadata;
  const requests = new NativeT3RunRequestStore({ ...metadata, async set() { throw new Error("database unavailable"); } });
  const service = new TemporalNativeT3RunService(new NativeT3RunCoordinator(durability), requests, {
    async start() { launches++; return { started: true }; }, async cancel() { return true; }, async steer() { return false; },
  });
  const request: NativeT3RunRequest = { runId: "not-started", canonicalThreadId: "thread", provider: "codex", title: "Test", text: "Test",
    modelSelection: { instanceId: "codex", model: "gpt-5" }, inputFiles: [], collectArtifacts: false, createdAt: new Date().toISOString() };
  await assert.rejects(service.startTurn(request), /database unavailable/);
  assert.equal(await service.run(request.runId), null);
  assert.equal(launches, 0);
});

test("duplicate starts keep the original durable request and launch failures terminalize the run", async () => {
  const durability = await createAgentRunDurability({ COMPADRE_DURABILITY_BACKEND: "memory" });
  assert.ok(durability);
  const requests = new NativeT3RunRequestStore(memoryPersistence().stores.metadata);
  let fail = false;
  const service = new TemporalNativeT3RunService(new NativeT3RunCoordinator(durability), requests, {
    async start() { if (fail) throw new Error("launch rejected"); return { started: true }; }, async cancel() { return true; }, async steer() { return false; },
  });
  const request: NativeT3RunRequest = { runId: "started", canonicalThreadId: "thread", provider: "codex", title: "Test", text: "Original",
    modelSelection: { instanceId: "codex", model: "gpt-5" }, inputFiles: [], collectArtifacts: false, createdAt: new Date().toISOString() };
  await Promise.all([service.startTurn(request), service.startTurn({ ...request, text: "Replacement" })]);
  assert.equal((await requests.getRequest(request.runId))?.text, "Original");
  fail = true;
  await assert.rejects(service.startTurn({ ...request, runId: "failed-launch" }), /launch rejected/);
  assert.equal((await service.run("failed-launch"))?.status, "failed");
});

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
