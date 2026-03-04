import { execFileSync } from "child_process";
import { existsSync, writeFileSync, mkdirSync, chmodSync } from "fs";
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
  return process.env.REPO_BRANCH || "qa";
}

function isLocalDev() {
  return REPO_PATH.includes("/Users/");
}

const PROTECTED_BRANCHES = ["qa", "main", "master", "prod", "production"];

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

/**
 * Reset the repo to clean qa state. Called before and after each agent session
 * so the next session always starts from a known-good state.
 * Skipped in local dev to avoid trashing your working tree.
 */
export function resetToQa() {
  if (isLocalDev()) return;

  const branch = getRepoBranch();

  try {
    git("-C", REPO_PATH, "checkout", branch);
    git("-C", REPO_PATH, "clean", "-fd");
    git("-C", REPO_PATH, "fetch", "origin", branch);
    git("-C", REPO_PATH, "reset", "--hard", `origin/${branch}`);
    console.log("[repo] reset to clean qa state");
  } catch (err) {
    console.error("[repo] reset to qa failed:", err);
  }
}
