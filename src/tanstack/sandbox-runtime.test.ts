import assert from "node:assert/strict";
import test from "node:test";
import {
  createHarnessSandbox,
  harnessWorkspacePath,
} from "./sandbox-runtime.js";

test("always uses the Modal workspace path", () => {
  const environment = {
    COMPADRE_MODAL_WORKDIR: "/remote/repository",
  };
  assert.equal(
    harnessWorkspacePath("/tmp/local-worktree", environment),
    "/remote/repository",
  );
});

test("snapshots persisted thread sandboxes and releases their compute", () => {
  const sandbox = createHarnessSandbox({
    worktreeId: "thread-workspace",
    localWorktreePath: "/unused",
    environment: { MODAL_TOKEN_ID: "test-id", MODAL_TOKEN_SECRET: "test-secret" },
  });
  assert.deepEqual(sandbox.lifecycle, {
    reuse: "thread",
    snapshot: "after-run",
    destroyOnComplete: false,
  });
});

test("keeps generated one-shot sandboxes ephemeral", () => {
  const sandbox = createHarnessSandbox({
    worktreeId: "one-shot",
    localWorktreePath: "/unused",
    reuseThread: false,
    environment: { MODAL_TOKEN_ID: "test-id", MODAL_TOKEN_SECRET: "test-secret" },
  });
  assert.deepEqual(sandbox.lifecycle, {
    reuse: "none",
    snapshot: "none",
    destroyOnComplete: true,
  });
  const setup = sandbox.workspace?.setup;
  assert.ok(Array.isArray(setup));
  assert.equal(setup.length, 1);
  assert.match(String(setup[0]), /^git .*clone/);
  assert.doesNotMatch(String(setup[0]), /npm install/);
});

test("does not project skills before the setup-time clone", () => {
  const sandbox = createHarnessSandbox({
    worktreeId: "skill-workspace",
    localWorktreePath: "/unused",
    environment: { MODAL_TOKEN_ID: "test-id", MODAL_TOKEN_SECRET: "test-secret" },
  });
  assert.deepEqual(sandbox.workspace?.skills, undefined);
});

test("writes Compadre skills after the setup-time clone", async () => {
  const sandbox = createHarnessSandbox({
    worktreeId: "skill-workspace",
    localWorktreePath: "/unused",
    environment: { MODAL_TOKEN_ID: "test-id", MODAL_TOKEN_SECRET: "test-secret" },
  });
  const directories: string[] = [];
  const files = new Map<string, Uint8Array>();
  const onReady = sandbox.hooks?.onReady;
  assert.ok(onReady);

  await onReady({
    fs: {
      mkdir: async (path: string) => { directories.push(path); },
      write: async (path: string, data: Uint8Array) => { files.set(path, data); },
    },
  } as never);

  assert.deepEqual(directories, [
    "/opt/compadre-skills/query-database",
    "/opt/compadre-skills/pull-request",
    "/opt/compadre-skills/integration-debugging",
  ]);
  assert.deepEqual([...files.keys()], [
    "/opt/compadre-skills/query-database/SKILL.md",
    "/opt/compadre-skills/pull-request/SKILL.md",
    "/opt/compadre-skills/integration-debugging/SKILL.md",
  ]);
  for (const data of files.values()) {
    assert.match(Buffer.from(data).toString("utf8"), /^---\nname:/);
  }
});

test("opts a T3 sandbox into Modal port tunnels", () => {
  const sandbox = createHarnessSandbox({
    worktreeId: "t3-server",
    localWorktreePath: "/unused",
    encryptedPorts: [3773],
    environment: { MODAL_TOKEN_ID: "test-id", MODAL_TOKEN_SECRET: "test-secret" },
  });

  assert.equal(sandbox.provider.capabilities().ports, true);
});
