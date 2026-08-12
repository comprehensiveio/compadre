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

export function gitEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...environment, ...gitAuthenticationEnvironment(environment) };
}

/** Git authentication safe to inherit without persisting a credentialed URL. */
export function gitAuthenticationEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const pat = environment.GITHUB_PERSONAL_ACCESS_TOKEN;
  if (!pat) return { GIT_TERMINAL_PROMPT: "0" };

  const repository = new URL(configuredRepositoryUrl(environment));
  if (repository.protocol !== "http:" && repository.protocol !== "https:") {
    return { GIT_TERMINAL_PROMPT: "0" };
  }

  // Keep credentials out of command arguments, exception messages, process
  // listings, and the persisted origin URL. Git reads this one-command config
  // only from the child environment.
  const authorization = Buffer.from(`x-access-token:${pat}`).toString("base64");
  const configuredCount = Number.parseInt(environment.GIT_CONFIG_COUNT ?? "0", 10);
  const index = Number.isInteger(configuredCount) && configuredCount >= 0
    ? configuredCount
    : 0;
  return {
    GIT_CONFIG_COUNT: String(index + 2),
    [`GIT_CONFIG_KEY_${index}`]: `http.${repository.origin}/.extraHeader`,
    [`GIT_CONFIG_VALUE_${index}`]: `Authorization: Basic ${authorization}`,
    [`GIT_CONFIG_KEY_${index + 1}`]: `http.${repository.origin}/.followRedirects`,
    [`GIT_CONFIG_VALUE_${index + 1}`]: "false",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function git(...args: string[]) {
  execFileSync("git", args, {
    env: gitEnvironment(),
    stdio: "inherit",
  });
}

export function configuredRepositoryUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.GITHUB_REPO_URL ||
    "https://github.com/comprehensiveio/comp.git"
  );
}

function getRepoBranch() {
  return process.env.REPO_BRANCH || "main";
}

export function configuredRepositorySeedPath(): string {
  return (
    process.env.COMPADRE_REPO_SEED_PATH ||
    path.resolve(".workflow-cache", "repository")
  );
}

function hasRepositorySeed(seedPath: string): boolean {
  return (
    existsSync(path.join(seedPath, ".git")) ||
    existsSync(path.join(seedPath, "HEAD"))
  );
}

function gitOutput(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function remoteBranchRevision(repoUrl: string, branch: string): string {
  const output = execFileSync(
    "git",
    ["ls-remote", "--exit-code", repoUrl, `refs/heads/${branch}`],
    {
      encoding: "utf8",
      env: gitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
  const revision = output.split(/\s+/, 1)[0];
  if (!/^[a-f0-9]{40,64}$/i.test(revision)) {
    throw new Error(`Git returned an invalid revision for ${branch}`);
  }
  return revision;
}

export function repositoryNeedsFetch(
  localRevision: string,
  remoteRevision: string,
): boolean {
  return localRevision !== remoteRevision;
}

export function refreshExistingRepository(
  repoPath: string,
  repoUrl: string,
  branch: string,
  singleUse = process.env.COMPADRE_SINGLE_USE_REPOSITORY === "true",
): void {
  git("-C", repoPath, "remote", "set-url", "origin", repoUrl);

  let needsFetch = true;
  if (singleUse) {
    try {
      needsFetch = repositoryNeedsFetch(
        gitOutput(repoPath, "rev-parse", `origin/${branch}`),
        remoteBranchRevision(repoUrl, branch),
      );
    } catch (error) {
      console.warn(
        "[repo] could not compare baked checkout with the remote; fetching",
        error,
      );
    }
  }

  if (needsFetch) {
    git("-C", repoPath, "fetch", "origin", branch);
    git("-C", repoPath, "reset", "--hard", `origin/${branch}`);
  } else {
    console.log(`[repo] baked checkout already matches origin/${branch}`);
  }
}

function isLocalDev() {
  return REPO_PATH.includes("/Users/");
}

export function usesRepositoryAsWorktree(
  repoPath = REPO_PATH,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return (
    repoPath.includes("/Users/") ||
    environment.COMPADRE_SINGLE_USE_REPOSITORY === "true"
  );
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

  const repoUrl = configuredRepositoryUrl();
  const branch = getRepoBranch();
  const seedPath = configuredRepositorySeedPath();

  if (existsSync(`${REPO_PATH}/.git`)) {
    console.log("[repo] pulling latest changes");
    // Older Compadre versions embedded the PAT in this URL. Always rewrite it
    // to the credential-free configured URL before any network operation.
    refreshExistingRepository(REPO_PATH, repoUrl, branch);
  } else if (hasRepositorySeed(seedPath)) {
    console.log(`[repo] cloning repository from image seed at ${seedPath}`);
    git(
      "clone",
      // A shallow bare repository cannot use Git's local-clone optimization.
      // Force the local transport so the checkout remains independent from the
      // immutable image seed and works across Render filesystem boundaries.
      "--no-local",
      "--single-branch",
      "--branch",
      branch,
      seedPath,
      REPO_PATH,
    );
    git("-C", REPO_PATH, "remote", "set-url", "origin", repoUrl);
    try {
      git("-C", REPO_PATH, "fetch", "--depth", "1", "origin", branch);
    } catch (error) {
      console.warn(
        "[repo] seeded repository could not fetch the latest revision; using the image revision",
        error,
      );
    }
    git("-C", REPO_PATH, "reset", "--hard", `origin/${branch}`);
  } else {
    console.log("[repo] cloning repository");
    git(
      "clone",
      "--depth",
      "1",
      "--filter=blob:none",
      "--single-branch",
      "--branch",
      branch,
      repoUrl,
      REPO_PATH,
    );
  }

  installBranchGuards();
}

/**
 * Populate the immutable repository seed that is packaged into the Workflow
 * image. This runs during the Workflow build, never on the request path.
 */
export function prepareRepositorySeed(
  seedPath = configuredRepositorySeedPath(),
): string {
  const repoUrl = configuredRepositoryUrl();
  const branch = getRepoBranch();
  mkdirSync(path.dirname(seedPath), { recursive: true });

  // Always recreate the checkout. It is both a self-contained shallow seed
  // and the editable worktree used directly by an isolated Workflow task.
  // Avoid partial clones: their lazy object fetches are not reliable once
  // Render packages the build output into a task image.
  rmSync(seedPath, { recursive: true, force: true });
  console.log(`[repo-seed] cloning editable ${repoUrl} into ${seedPath}`);
  git(
    "clone",
    "--depth",
    "1",
    "--single-branch",
    "--branch",
    branch,
    repoUrl,
    seedPath,
  );

  // Fail the build instead of publishing an incomplete runtime seed.
  git("-C", seedPath, "fsck", "--full", "--no-dangling");
  return seedPath;
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
  if (usesRepositoryAsWorktree()) return REPO_PATH;

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
  if (usesRepositoryAsWorktree()) return;

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
  if (usesRepositoryAsWorktree()) return;
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
