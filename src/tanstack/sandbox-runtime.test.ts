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
