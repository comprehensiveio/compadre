import assert from "node:assert/strict";
import dotenv from "dotenv";
import { memoryPersistence } from "@tanstack/ai-persistence";
import { T3ThreadBindingStore } from "../src/services/t3-thread-bindings.js";
import { T3Gateway } from "../src/t3/gateway.js";
import { T3ModalEnvironmentManager } from "../src/t3/modal-environments.js";

dotenv.config({ path: ".env.local", quiet: true, override: true });

// Keep the canary image only long enough to inspect a failed probe. Production
// retains worker snapshots for seven days; this probe intentionally does not.
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  COMPADRE_MODAL_SNAPSHOT_TTL_MS:
    process.env.COMPADRE_T3_PROBE_SNAPSHOT_TTL_MS?.trim() || "3600000",
};
const persistence = memoryPersistence();
const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
const manager = new T3ModalEnvironmentManager(environment);
const canonicalThreadId = `hibernation-probe-${Date.now()}`;
const markerPath = "/workspace/.compadre-hibernation-probe";
const marker = `resume-${crypto.randomUUID()}`;
let clock = new Date();

function gateway(): T3Gateway {
  return new T3Gateway(
    bindings,
    manager,
    () => crypto.randomUUID(),
    () => clock,
    undefined,
    undefined,
    undefined,
    {
      warmLeaseMs: 30 * 60 * 1000,
      schedule: () => undefined,
    },
  );
}

const modelSelection = {
  instanceId: process.env.COMPADRE_T3_PROBE_PROVIDER?.trim() || "codex",
  model: process.env.COMPADRE_T3_PROBE_MODEL?.trim() || "gpt-5.6-sol",
};

try {
  const firstController = gateway();
  const firstTurn = await firstController.send({
    canonicalThreadId,
    title: "Modal hibernation probe",
    text: "Reply with FIRST_TURN_OK only.",
    modelSelection,
  });
  const firstTerminal = await firstController.waitForTerminal({
    turn: firstTurn,
    timeoutMs: 10 * 60_000,
  });
  assert.equal(firstTerminal.thread.latestTurn?.state, "completed");

  const live = await manager.reconnect(firstTurn.binding);
  assert.ok(
    live.sandbox,
    "The live Modal connection must expose its filesystem",
  );
  await live.sandbox.fs.write(markerPath, marker);

  // Jump the controller clock beyond the warm lease and construct a new
  // gateway to model a Render process restart before the lifecycle sweep.
  clock = new Date(clock.getTime() + 31 * 60 * 1000);
  const restartedController = gateway();
  await restartedController.sweepExpiredWarmWorkers();
  const suspended = await bindings.get(canonicalThreadId);
  assert.equal(suspended?.workerState, "suspended");
  assert.ok(suspended.workerSnapshotId);

  // The original sandbox must have been terminated by snapshot().
  await assert.rejects(manager.reconnect(suspended));

  clock = new Date(clock.getTime() + 149 * 60 * 1000);
  const resumedTurn = await restartedController.send({
    canonicalThreadId,
    title: "Modal hibernation probe",
    text: "Reply with SECOND_TURN_OK only.",
    modelSelection,
  });
  assert.notEqual(resumedTurn.binding.sandboxId, firstTurn.binding.sandboxId);
  assert.equal(resumedTurn.binding.t3ThreadId, firstTurn.binding.t3ThreadId);
  assert.equal(resumedTurn.binding.workerGeneration, 2);

  const restored = await manager.reconnect(resumedTurn.binding);
  assert.ok(restored.sandbox);
  assert.equal(await restored.sandbox.fs.read(markerPath), marker);
  const secondTerminal = await restartedController.waitForTerminal({
    turn: resumedTurn,
    timeoutMs: 10 * 60_000,
  });
  assert.equal(secondTerminal.thread.latestTurn?.state, "completed");

  console.log(
    JSON.stringify(
      {
        outcome: "passed",
        canonicalThreadId,
        t3ThreadId: resumedTurn.binding.t3ThreadId,
        firstSandboxId: firstTurn.binding.sandboxId,
        restoredSandboxId: resumedTurn.binding.sandboxId,
        workerGeneration: resumedTurn.binding.workerGeneration,
        filesystemMarkerRestored: true,
        firstTerminalState: firstTerminal.thread.latestTurn?.state,
        secondTerminalState: secondTerminal.thread.latestTurn?.state,
      },
      null,
      2,
    ),
  );
} finally {
  const binding = await bindings.get(canonicalThreadId).catch(() => null);
  if (binding) {
    const connection = await manager.reconnect(binding).catch(() => null);
    if (connection) await manager.discard(connection).catch(() => undefined);
  }
}
