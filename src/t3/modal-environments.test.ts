import assert from "node:assert/strict";
import test from "node:test";
import type { T3ThreadBinding } from "../services/t3-thread-bindings.js";
import type { T3OrchestrationSnapshot, T3Thread } from "./client.js";
import {
  assertProviderCredentialsConfigured,
  assertIsolatedT3Environment,
  T3ModalEnvironmentManager,
} from "./modal-environments.js";
import type { SandboxHandle } from "@tanstack/ai-sandbox";

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

test("requires a configured Claude credential before provisioning a billed worker", async () => {
  let launched = false;
  const manager = new T3ModalEnvironmentManager({}, undefined, {
    async launch() {
      launched = true;
      return {} as never;
    },
  });

  await assert.rejects(
    manager.provision({
      canonicalThreadId: "thread-claude",
      providerInstanceId: "claudeAgent",
    }),
    /neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is configured/,
  );
  assert.equal(launched, false);
});

test("requires a configured Claude credential before restoring a worker", async () => {
  let restored = false;
  const manager = new T3ModalEnvironmentManager({}, undefined, {
    async restore() {
      restored = true;
      return {} as never;
    },
  });

  await assert.rejects(
    manager.restore({
      ...binding,
      providerInstanceId: "claudeAgent",
      workerSnapshotId: "snapshot-claude",
    }),
    /neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is configured/,
  );
  assert.equal(restored, false);
});

test("accepts either supported Claude credential and does not constrain Codex", () => {
  assert.doesNotThrow(() =>
    assertProviderCredentialsConfigured("claudeAgent", {
      ANTHROPIC_API_KEY: "anthropic-key",
    }),
  );
  assert.doesNotThrow(() =>
    assertProviderCredentialsConfigured("claudeAgent", {
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
    }),
  );
  assert.doesNotThrow(() => assertProviderCredentialsConfigured("codex", {}));
});

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

test("quiesces development services before snapshotting and terminating a worker", async () => {
  const events: Array<{ command: string; cwd?: string } | string> = [];
  const sandbox = {
    workspaceRoot: "/workspace/repository",
    capabilities: { snapshots: true },
    process: {
      async exec(command: string, options?: { cwd?: string }) {
        events.push({ command, cwd: options?.cwd });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    async snapshot(label: string) {
      events.push(`snapshot:${label}`);
      return { id: "im-worker-1", label };
    },
  } as unknown as SandboxHandle;
  const manager = new T3ModalEnvironmentManager({});

  assert.deepEqual(
    await manager.hibernate(binding, {
      sandboxId: binding.sandboxId,
      projectId: binding.projectId,
      client: {} as never,
      sandbox,
    }),
    { snapshotId: "im-worker-1" },
  );
  assert.match(
    (events[0] as { command: string }).command,
    /compadre-dev-up\.sh down/,
  );
  assert.match((events[0] as { command: string }).command, /kill \"\$pid\"/);
  assert.equal((events[0] as { cwd?: string }).cwd, "/workspace/repository");
  assert.equal(events[1], "snapshot:t3-worker-generation-1");
});

test("restarts T3 after snapshot capture fails", async () => {
  let restarted = false;
  const snapshotError = new Error("snapshot capture failed");
  const sandbox = {
    workspaceRoot: "/workspace",
    capabilities: { snapshots: true },
    process: {
      async exec() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    async snapshot() {
      throw snapshotError;
    },
  } as unknown as SandboxHandle;
  const manager = new T3ModalEnvironmentManager({}, undefined, {
    async restart(handle, identity) {
      restarted = true;
      assert.equal(handle, sandbox);
      assert.deepEqual(identity, {
        projectId: binding.projectId,
        t3ThreadId: binding.t3ThreadId,
      });
      return {} as never;
    },
  });

  await assert.rejects(
    manager.hibernate(binding, {
      sandboxId: binding.sandboxId,
      projectId: binding.projectId,
      client: {} as never,
      sandbox,
    }),
    snapshotError,
  );
  assert.equal(restarted, true);
});
