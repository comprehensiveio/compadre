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
