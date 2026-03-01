import { execSync } from "child_process";
import { existsSync } from "fs";

function getRepoPath() {
  return process.env.REPO_PATH || "/tmp/comp-repo";
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
  const repoPath = getRepoPath();
  return repoPath.includes("/Users/");
}

export function ensureRepo() {
  const repoPath = getRepoPath();

  if (isLocalDev()) {
    console.log(`[repo] using local repo at ${repoPath}`);
    return;
  }

  const repoUrl = getRepoUrl();
  const branch = getRepoBranch();

  if (existsSync(`${repoPath}/.git`)) {
    console.log("[repo] pulling latest changes");
    execSync(`git -C ${repoPath} fetch origin ${branch}`, {
      stdio: "inherit",
    });
    execSync(`git -C ${repoPath} reset --hard origin/${branch}`, {
      stdio: "inherit",
    });
  } else {
    console.log("[repo] cloning repository");
    execSync(
      `git clone --depth 1 --branch ${branch} ${repoUrl} ${repoPath}`,
      { stdio: "inherit" }
    );
  }
}

export function refreshRepo() {
  if (isLocalDev()) return;

  const repoPath = getRepoPath();
  const branch = getRepoBranch();

  try {
    execSync(
      `git -C ${repoPath} fetch origin ${branch} && git -C ${repoPath} reset --hard origin/${branch}`,
      { stdio: "inherit" }
    );
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

  const repoPath = getRepoPath();
  const branch = getRepoBranch();

  try {
    execSync(
      `git -C ${repoPath} checkout ${branch} 2>/dev/null; git -C ${repoPath} clean -fd; git -C ${repoPath} fetch origin ${branch} && git -C ${repoPath} reset --hard origin/${branch}`,
      { stdio: "inherit" }
    );
    console.log("[repo] reset to clean qa state");
  } catch (err) {
    console.error("[repo] reset to qa failed:", err);
  }
}
