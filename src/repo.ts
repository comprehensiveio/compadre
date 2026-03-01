import { execFileSync } from "child_process";
import { existsSync } from "fs";
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

export function ensureRepo() {
  if (isLocalDev()) {
    console.log(`[repo] using local repo at ${REPO_PATH}`);
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
