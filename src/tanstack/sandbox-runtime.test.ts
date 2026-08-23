import assert from "node:assert/strict";
import test from "node:test";
import {
  createHarnessSandbox,
  harnessWorkspacePath,
} from "./sandbox-runtime.js";

test("always uses the Daytona workspace path", () => {
  const environment = {
    COMPADRE_DAYTONA_WORKDIR: "/remote/repository",
  };
  assert.equal(
    harnessWorkspacePath("/tmp/local-worktree", environment),
    "/remote/repository",
  );
});

test("rejects a Daytona auto-stop shorter than the controller cleanup window", () => {
  assert.throws(
    () =>
      createHarnessSandbox({
        worktreeId: "too-short",
        localWorktreePath: "/unused",
        environment: {
          COMPADRE_DAYTONA_AUTO_STOP_MINUTES: "35",
        },
      }),
    /integer of at least 36/,
  );
});

test("reuses persisted thread sandboxes without destroying successful work", () => {
  const sandbox = createHarnessSandbox({
    worktreeId: "thread-workspace",
    localWorktreePath: "/unused",
    environment: { DAYTONA_API_KEY: "test-key" },
  });
  assert.deepEqual(sandbox.lifecycle, {
    reuse: "thread",
    snapshot: "none",
    keepAlive: "40m",
    destroyOnComplete: false,
  });
});

test("keeps generated one-shot sandboxes ephemeral", () => {
  const sandbox = createHarnessSandbox({
    worktreeId: "one-shot",
    localWorktreePath: "/unused",
    reuseThread: false,
    environment: { DAYTONA_API_KEY: "test-key" },
  });
  assert.deepEqual(sandbox.lifecycle, {
    reuse: "none",
    snapshot: "none",
    destroyOnComplete: true,
  });
});
