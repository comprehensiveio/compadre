import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
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
import { promisify } from "node:util";
import {
  configuredRepositoryUrl,
  isRemovableStaleWorktree,
  prepareRepositorySeed,
  prepareWorktree,
  usesRepositoryAsWorktree,
} from "./repo.js";

const execFile = promisify(execFileCallback);

test("keeps GitHub credentials out of the configured repository URL", () => {
  const token = "secret-token";
  const url = configuredRepositoryUrl({
    GITHUB_REPO_URL: "https://github.com/comprehensiveio/comp.git",
    GITHUB_PERSONAL_ACCESS_TOKEN: token,
  });

  assert.equal(url, "https://github.com/comprehensiveio/comp.git");
  assert.equal(url.includes(token), false);
});

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

test("uses the base checkout directly only for local or single-use tasks", () => {
  assert.equal(
    usesRepositoryAsWorktree("/opt/render/repo", {
      COMPADRE_SINGLE_USE_REPOSITORY: "true",
    }),
    true,
  );
  assert.equal(usesRepositoryAsWorktree("/Users/test/comp", {}), true);
  assert.equal(usesRepositoryAsWorktree("/opt/render/repo", {}), false);
});

test("builds a self-contained editable Workflow repository", async () => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "compadre-repo-seed-"));
  const sourcePath = path.join(testRoot, "source");
  const seedPath = path.join(testRoot, "repository");
  const previousUrl = process.env.GITHUB_REPO_URL;
  const previousBranch = process.env.REPO_BRANCH;

  try {
    await mkdir(sourcePath);
    await execFile("git", ["init", "--initial-branch", "main"], {
      cwd: sourcePath,
    });
    await writeFile(path.join(sourcePath, "README.md"), "seed contents\n");
    await execFile("git", ["add", "README.md"], { cwd: sourcePath });
    await execFile(
      "git",
      [
        "-c",
        "user.name=Compadre Test",
        "-c",
        "user.email=compadre@example.com",
        "commit",
        "-m",
        "seed",
      ],
      { cwd: sourcePath },
    );

    process.env.GITHUB_REPO_URL = `file://${sourcePath}`;
    process.env.REPO_BRANCH = "main";
    prepareRepositorySeed(seedPath);

    assert.equal(
      await readFile(path.join(seedPath, "README.md"), "utf8"),
      "seed contents\n",
    );
    assert.equal(
      (await execFile("git", ["-C", seedPath, "rev-parse", "--is-shallow-repository"]))
        .stdout.trim(),
      "true",
    );
  } finally {
    if (previousUrl === undefined) delete process.env.GITHUB_REPO_URL;
    else process.env.GITHUB_REPO_URL = previousUrl;
    if (previousBranch === undefined) delete process.env.REPO_BRANCH;
    else process.env.REPO_BRANCH = previousBranch;
    await rm(testRoot, { recursive: true, force: true });
  }
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
