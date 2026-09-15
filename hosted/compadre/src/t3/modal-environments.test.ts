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

test("checkpoints a running worker without quiescing or terminating it", async () => {
  const events: string[] = [];
  const sandbox = {
    workspaceRoot: "/workspace/repository",
    capabilities: { snapshots: true },
    process: {
      async exec(command: string) {
        events.push(`exec:${command}`);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    async checkpoint(label: string) {
      events.push(`checkpoint:${label}`);
      return { id: "im-worker-1", label };
    },
    async snapshot() {
      throw new Error("checkpoint must not use the terminating snapshot path");
    },
  } as unknown as SandboxHandle;
  const manager = new T3ModalEnvironmentManager({});

  assert.deepEqual(
    await manager.checkpoint(binding, {
      sandboxId: binding.sandboxId,
      projectId: binding.projectId,
      client: {} as never,
      sandbox,
    }),
    { snapshotId: "im-worker-1" },
  );
  // Live checkpoint: no dev-stack teardown, no T3 kill, no terminate.
  assert.deepEqual(events, ["checkpoint:t3-worker-generation-1"]);
});

function managedEnvironment(sandboxId: string) {
  return {
    sandboxId,
    baseUrl: "https://worker.example",
    pairingUrl: "https://worker.example/pair",
    workspaceRoot: "/workspace",
    projectId: "project-1",
    client: {} as never,
    handle: {} as never,
  };
}

test("provisions from the golden template when one is published", async () => {
  const calls: string[] = [];
  const manager = new T3ModalEnvironmentManager({}, undefined, {
    async workerTemplate() {
      return {
        snapshotId: "im-template-1",
        repoSha: "abc123",
        backupKey: "hourly/backup.sql.gz",
        builtAt: new Date().toISOString(),
      };
    },
    launchFromTemplate: async (snapshotId) => {
      calls.push(`template:${snapshotId}`);
      return managedEnvironment("sandbox-from-template");
    },
    async launch() {
      calls.push("cold");
      return managedEnvironment("sandbox-cold");
    },
  });

  const connection = await manager.provision({
    canonicalThreadId: "thread-template",
    providerInstanceId: "codex",
  });

  assert.deepEqual(calls, ["template:im-template-1"]);
  assert.equal(connection.sandboxId, "sandbox-from-template");
});

test("provisions cold when no template is published", async () => {
  const calls: string[] = [];
  const manager = new T3ModalEnvironmentManager({}, undefined, {
    async workerTemplate() {
      return null;
    },
    launchFromTemplate: async () => {
      calls.push("template");
      return managedEnvironment("sandbox-from-template");
    },
    async launch() {
      calls.push("cold");
      return managedEnvironment("sandbox-cold");
    },
  });

  const connection = await manager.provision({
    canonicalThreadId: "thread-cold",
    providerInstanceId: "codex",
  });

  assert.deepEqual(calls, ["cold"]);
  assert.equal(connection.sandboxId, "sandbox-cold");
});

for (const providerInstanceId of ["codex", "claudeAgent"]) {
  test(`${providerInstanceId} cold provisions after a fresh template expires in Modal`, async () => {
    const calls: string[] = [];
    const manager = new T3ModalEnvironmentManager(
      { ANTHROPIC_API_KEY: "test" },
      undefined,
      {
        workerTemplate: async () => ({
          snapshotId: "im-expired",
          repoSha: "sha",
          backupKey: "backup",
          builtAt: new Date().toISOString(),
        }),
        launchFromTemplate: async () => {
          calls.push("template");
          throw Object.assign(
            new Error(
              "/modal.client.ModalClient/SandboxCreate NOT_FOUND: Image 'im-expired' has expired",
            ),
            {
              code: 5,
              path: "/modal.client.ModalClient/SandboxCreate",
              details: "Image 'im-expired' has expired",
            },
          );
        },
        launch: async (environment) => {
          assert.equal(
            environment?.COMPADRE_CANONICAL_THREAD_ID,
            "thread-fallback",
          );
          assert.equal(
            environment?.COMPADRE_PROVIDER_INSTANCE_ID,
            providerInstanceId,
          );
          calls.push("cold");
          return managedEnvironment("sandbox-cold");
        },
      },
    );
    assert.equal(
      (
        await manager.provision({
          canonicalThreadId: "thread-fallback",
          providerInstanceId,
        })
      ).sandboxId,
      "sandbox-cold",
    );
    assert.deepEqual(calls, ["template", "cold"]);
  });
}

for (const builtAt of [
  "2026-01-01T00:00:00Z",
  "invalid",
  "2999-01-01T00:00:00Z",
]) {
  test(`cold provisions without restoring an unusable template timestamp: ${builtAt}`, async () => {
    const manager = new T3ModalEnvironmentManager({}, undefined, {
      workerTemplate: async () => ({
        snapshotId: "im-stale",
        repoSha: "sha",
        backupKey: "backup",
        builtAt,
      }),
      launchFromTemplate: async () => {
        throw new Error("Must not restore stale template");
      },
      launch: async () => managedEnvironment("sandbox-cold"),
    });
    assert.equal(
      (
        await manager.provision({
          canonicalThreadId: "thread-stale",
          providerInstanceId: "codex",
        })
      ).sandboxId,
      "sandbox-cold",
    );
  });
}

test("does not hide non-image failures", async () => {
  const failure = new Error("template checkout refresh failed");
  const manager = new T3ModalEnvironmentManager({}, undefined, {
    workerTemplate: async () => ({
      snapshotId: "im-current",
      repoSha: "sha",
      backupKey: "backup",
      builtAt: new Date().toISOString(),
    }),
    launchFromTemplate: async () => {
      throw failure;
    },
    launch: async () => {
      assert.fail("Must not cold provision after a checkout failure");
    },
  });
  await assert.rejects(
    manager.provision({
      canonicalThreadId: "thread-error",
      providerInstanceId: "codex",
    }),
    failure,
  );
});

test("propagates cold provisioning failure after an expired image", async () => {
  const failure = new Error("Modal spend limit exceeded");
  const manager = new T3ModalEnvironmentManager({}, undefined, {
    workerTemplate: async () => ({
      snapshotId: "im-old",
      repoSha: "sha",
      backupKey: "backup",
      builtAt: new Date().toISOString(),
    }),
    launchFromTemplate: async () => {
      throw new Error(
        "/modal.client.ModalClient/SandboxCreate NOT_FOUND: Image 'im-old' has expired",
      );
    },
    launch: async () => {
      throw failure;
    },
  });
  await assert.rejects(
    manager.provision({
      canonicalThreadId: "thread-error",
      providerInstanceId: "codex",
    }),
    failure,
  );
});
