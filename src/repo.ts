import { execFileSync } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import path from "path";
import { LocalProcessHandle } from "@tanstack/ai-sandbox-local-process";
import { REPO_PATH } from "./config.js";

function git(...args: string[]) {
  execFileSync("git", args, { stdio: "inherit" });
}

function getRepoUrl() {
  const base =
    process.env.GITHUB_REPO_URL ||
    "https://github.com/comprehensiveio/comp.git";
  const pat = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  if (pat && base.startsWith("https://")) {
    return base.replace("https://", `https://x-access-token:${pat}@`);
  }
  return base;
}

function getRepoBranch() {
  return process.env.REPO_BRANCH || "main";
}

function gitOutput(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function isLocalDev() {
  return REPO_PATH.includes("/Users/");
}

const PROTECTED_BRANCHES = ["main", "master", "prod", "production"];

/**
 * Install git hooks that prevent committing to or pushing protected branches.
 * Hooks live in .git/hooks/ so they survive git clean and git reset --hard.
 */
function installBranchGuards() {
  const hooksDir = `${REPO_PATH}/.git/hooks`;
  mkdirSync(hooksDir, { recursive: true });

  const branchList = PROTECTED_BRANCHES.join(" ");

  const preCommitHook = `#!/bin/sh
# Installed by compadre — prevent committing directly to protected branches
PROTECTED="${branchList}"
current_branch=$(git rev-parse --abbrev-ref HEAD)
for branch in $PROTECTED; do
  if [ "$current_branch" = "$branch" ]; then
    echo "ERROR: Committing directly to '$branch' is not allowed."
    echo "Create a feature branch first: git checkout -b isaac/<ticket>-description"
    exit 1
  fi
done
`;

  const prePushHook = `#!/bin/sh
# Installed by compadre — prevent pushing protected branches
PROTECTED="${branchList}"
current_branch=$(git rev-parse --abbrev-ref HEAD)
for branch in $PROTECTED; do
  if [ "$current_branch" = "$branch" ]; then
    echo "ERROR: Pushing to '$branch' is not allowed."
    echo "Create a feature branch first: git checkout -b isaac/<ticket>-description"
    exit 1
  fi
done
`;

  writeFileSync(`${hooksDir}/pre-commit`, preCommitHook);
  chmodSync(`${hooksDir}/pre-commit`, 0o755);
  writeFileSync(`${hooksDir}/pre-push`, prePushHook);
  chmodSync(`${hooksDir}/pre-push`, 0o755);
  console.log("[repo] installed branch guard hooks");
}

export function ensureRepo() {
  if (isLocalDev()) {
    console.log(`[repo] using local repo at ${REPO_PATH}`);
    installBranchGuards();
    return;
  }

  const repoUrl = getRepoUrl();
  const branch = getRepoBranch();

  if (existsSync(`${REPO_PATH}/.git`)) {
    console.log("[repo] pulling latest changes");
    git("-C", REPO_PATH, "fetch", "origin", branch);
    git("-C", REPO_PATH, "reset", "--hard", `origin/${branch}`);
  } else {
    console.log("[repo] cloning repository");
    git("clone", "--depth", "1", "--branch", branch, repoUrl, REPO_PATH);
  }

  installBranchGuards();
}

export function refreshRepo() {
  if (isLocalDev()) return;

  const branch = getRepoBranch();

  try {
    git("-C", REPO_PATH, "fetch", "origin", branch);
    git("-C", REPO_PATH, "reset", "--hard", `origin/${branch}`);
    console.log("[repo] refreshed to latest");
  } catch (err) {
    console.error("[repo] refresh failed:", err);
  }
}

const WORKTREES_DIR = path.resolve(REPO_PATH, "..", "comp-worktrees");

/** Commit new worktrees are expected to start from. */
export function currentRepoRevision(): string | undefined {
  try {
    return gitOutput(REPO_PATH, "rev-parse", `origin/${getRepoBranch()}`);
  } catch {
    return undefined;
  }
}

/** Commit currently checked out in one thread worktree. */
export function worktreeRevision(worktreePath: string): string | undefined {
  try {
    return gitOutput(worktreePath, "rev-parse", "HEAD");
  } catch {
    return undefined;
  }
}

/**
 * Create a git worktree for isolated agent work.
 * Returns the absolute path to the worktree directory.
 * On local dev, returns REPO_PATH directly (no worktree created).
 * Idempotent — if the worktree path already exists, returns it as-is.
 */
export function createWorktree(id: string): string {
  if (isLocalDev()) return REPO_PATH;

  const worktreePath = path.join(WORKTREES_DIR, id);
  if (existsSync(worktreePath)) {
    console.log(`[repo] reusing existing worktree: ${worktreePath}`);
    return worktreePath;
  }

  const branch = getRepoBranch();
  mkdirSync(WORKTREES_DIR, { recursive: true });

  // Fetch latest before creating worktree so it's up to date
  try {
    git("-C", REPO_PATH, "fetch", "origin", branch);
  } catch (err) {
    console.error("[repo] fetch before worktree creation failed:", err);
  }

  // Prune stale metadata in case a previous worktree was removed uncleanly
  try {
    git("-C", REPO_PATH, "worktree", "prune");
  } catch {
    // ignore
  }

  git("-C", REPO_PATH, "worktree", "add", worktreePath, "--detach", `origin/${branch}`);
  console.log(`[repo] created worktree: ${worktreePath}`);
  return worktreePath;
}

/**
 * Bring a worktree to the same validated state required by a harness session.
 * This is also used off the request path to populate the prepared-worktree
 * cache. The sandbox repeats the idempotent check when it claims the worktree.
 */
export async function prepareWorktree(
  worktreePath: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  const handle = new LocalProcessHandle({
    root: worktreePath,
    removeOnDestroy: false,
    forkFactory: () => Promise.reject(new Error("worktree setup cannot fork")),
  });
  try {
    const result = await handle.process.exec("scripts/worktree-up.sh --hook", {
      signal,
    });
    if (signal?.aborted) throw signal.reason;
    if (result.exitCode !== 0) {
      throw new Error(
        `worktree setup exited with code ${result.exitCode}: ${result.stderr.slice(-1_000)}`,
      );
    }
  } finally {
    await handle.destroy();
  }
}

/**
 * Remove a git worktree by id. Silently ignores errors.
 */
export function removeWorktree(id: string): void {
  if (isLocalDev()) return;

  const worktreePath = path.join(WORKTREES_DIR, id);
  try {
    git("-C", REPO_PATH, "worktree", "remove", worktreePath, "--force");
    console.log(`[repo] removed worktree: ${worktreePath}`);
  } catch {
    // Worktree may already be gone — try cleaning up the directory directly
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * Remove worktrees older than maxAgeMs. Called periodically to clean up
 * abandoned worktrees from crashed tasks or pruned sessions.
 */
export function isRemovableStaleWorktree(
  worktreeId: string,
  modifiedAt: number,
  now: number,
  maxAgeMs: number,
  retainedWorktreeIds: ReadonlySet<string>
): boolean {
  return (
    !retainedWorktreeIds.has(worktreeId) && now - modifiedAt > maxAgeMs
  );
}

export function cleanupStaleWorktrees(
  maxAgeMs: number,
  retainedWorktreeIds: ReadonlySet<string> = new Set()
): void {
  if (isLocalDev()) return;
  if (!existsSync(WORKTREES_DIR)) return;

  const now = Date.now();
  let entries: string[];
  try {
    entries = readdirSync(WORKTREES_DIR);
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(WORKTREES_DIR, entry);
    try {
      const stat = statSync(entryPath);
      if (
        stat.isDirectory() &&
        isRemovableStaleWorktree(
          entry,
          stat.mtimeMs,
          now,
          maxAgeMs,
          retainedWorktreeIds
        )
      ) {
        removeWorktree(entry);
        console.log(`[repo] cleaned up stale worktree: ${entry}`);
      }
    } catch {
      // ignore stat errors
    }
  }

  // Prune worktree metadata for any that were removed externally
  try {
    git("-C", REPO_PATH, "worktree", "prune");
  } catch {
    // ignore
  }
}
