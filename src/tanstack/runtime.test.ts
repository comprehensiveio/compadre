import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createHarnessSandbox,
  messagesForHarnessSession,
} from "./runtime.js";

async function fixtureWorktree(script: string): Promise<string> {
  const worktreePath = await mkdtemp(
    path.join(tmpdir(), "compadre-worktree-setup-")
  );
  const scriptsPath = path.join(worktreePath, "scripts");
  await mkdir(scriptsPath);
  const setupPath = path.join(scriptsPath, "worktree-up.sh");
  await writeFile(setupPath, `#!/bin/sh\n${script}\n`);
  await chmod(setupPath, 0o755);
  return worktreePath;
}

test("prepares a fresh worktree before a harness can use it", async () => {
  const worktreePath = await fixtureWorktree(
    "printf prepared > .compadre-worktree-ready"
  );
  const sandbox = createHarnessSandbox("prepared", worktreePath);
  const context = { threadId: "thread-prepared", runId: "run-prepared" };

  try {
    await sandbox.ensure(context);
    assert.equal(
      await readFile(
        path.join(worktreePath, ".compadre-worktree-ready"),
        "utf8"
      ),
      "prepared"
    );
  } finally {
    await sandbox.destroy(context);
    await rm(worktreePath, { recursive: true, force: true });
  }
});

test("does not start a harness when worktree preparation fails", async () => {
  const worktreePath = await fixtureWorktree("exit 17");
  const sandbox = createHarnessSandbox("failed", worktreePath);
  const context = { threadId: "thread-failed", runId: "run-failed" };

  try {
    await assert.rejects(
      sandbox.ensure(context),
      /setup step failed: scripts\/worktree-up\.sh --hook \(exit 17\)/
    );
  } finally {
    await sandbox.destroy(context);
    await rm(worktreePath, { recursive: true, force: true });
  }
});

test("replays the neutral transcript only when starting a fresh provider session", () => {
  const transcript = [
    { role: "user" as const, content: "first request" },
    { role: "assistant" as const, content: "first response" },
  ];
  const current = [{ role: "user" as const, content: "follow-up" }];

  assert.deepEqual(
    messagesForHarnessSession(current, transcript, undefined),
    [...transcript, ...current]
  );
  assert.deepEqual(
    messagesForHarnessSession(current, transcript, "native-session"),
    current
  );
});
