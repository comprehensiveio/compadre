import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { isRemovableStaleWorktree, prepareWorktree } from "./repo.js";

test("removes only stale worktrees that have no live thread owner", () => {
  const retained = new Set(["active"]);
  const now = 10_000;

  assert.equal(
    isRemovableStaleWorktree("orphan", 1_000, now, 5_000, retained),
    true
  );
  assert.equal(
    isRemovableStaleWorktree("active", 1_000, now, 5_000, retained),
    false
  );
  assert.equal(
    isRemovableStaleWorktree("recent", 9_000, now, 5_000, retained),
    false
  );
});

test("prepares a worktree through its checked-in setup script", async () => {
  const worktreePath = await mkdtemp(
    path.join(tmpdir(), "compadre-prepare-worktree-"),
  );
  const scriptsPath = path.join(worktreePath, "scripts");
  await mkdir(scriptsPath);
  const scriptPath = path.join(scriptsPath, "worktree-up.sh");
  await writeFile(
    scriptPath,
    "#!/bin/sh\nprintf prepared > .prepared-by-pool\n",
  );
  await chmod(scriptPath, 0o755);

  try {
    await prepareWorktree(worktreePath);
    assert.equal(
      await readFile(path.join(worktreePath, ".prepared-by-pool"), "utf8"),
      "prepared",
    );
  } finally {
    await rm(worktreePath, { recursive: true, force: true });
  }
});

test("aborting worktree preparation terminates its subprocess tree", async () => {
  const worktreePath = await mkdtemp(
    path.join(tmpdir(), "compadre-abort-worktree-"),
  );
  const scriptsPath = path.join(worktreePath, "scripts");
  await mkdir(scriptsPath);
  const scriptPath = path.join(scriptsPath, "worktree-up.sh");
  await writeFile(
    scriptPath,
    "#!/bin/sh\n(sleep 0.4; printf leaked > .leaked-child) &\nwait\n",
  );
  await chmod(scriptPath, 0o755);
  const abortController = new AbortController();

  try {
    const preparation = prepareWorktree(worktreePath, abortController.signal);
    setTimeout(
      () => abortController.abort(new Error("foreground requested")),
      25,
    );
    await assert.rejects(preparation, /foreground requested/);
    await delay(500);
    await assert.rejects(access(path.join(worktreePath, ".leaked-child")));
  } finally {
    await rm(worktreePath, { recursive: true, force: true });
  }
});
