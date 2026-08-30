import assert from "node:assert/strict";
import test from "node:test";
import type { T3ThreadBinding } from "../services/t3-thread-bindings.js";
import type { T3OrchestrationSnapshot, T3Thread } from "./client.js";
import { assertIsolatedT3Environment } from "./modal-environments.js";

const binding: T3ThreadBinding = {
  canonicalThreadId: "thread-1",
  providerInstanceId: "codex",
  t3ThreadId: "native-thread-1",
  projectId: "project-1",
  sandboxId: "sandbox-1",
  baseUrl: "https://t3.example",
  modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
  createdAt: "2026-08-26T15:00:00.000Z",
  updatedAt: "2026-08-26T15:00:00.000Z",
};

function thread(id: string): T3Thread {
  return {
    id,
    projectId: "project-1",
    title: id,
    modelSelection: binding.modelSelection,
    latestTurn: null,
    messages: [],
    session: null,
  };
}

function snapshot(threads: T3Thread[]): T3OrchestrationSnapshot {
  return {
    snapshotSequence: 1,
    projects: [
      {
        id: "project-1",
        title: "Project",
        workspaceRoot: "/workspace",
        defaultModelSelection: binding.modelSelection,
      },
    ],
    threads,
    updatedAt: "2026-08-26T15:00:00.000Z",
  };
}

test("accepts only the T3 thread assigned to a Modal sandbox", () => {
  assert.doesNotThrow(() =>
    assertIsolatedT3Environment(binding, snapshot([thread("native-thread-1")])),
  );
});

test("rejects a missing or additional T3 thread", () => {
  assert.throws(
    () => assertIsolatedT3Environment(binding, snapshot([])),
    /no longer contains its assigned thread/,
  );
  assert.throws(
    () =>
      assertIsolatedT3Environment(
        binding,
        snapshot([thread("native-thread-1"), thread("native-thread-2")]),
      ),
    /violates one-thread isolation/,
  );
});
