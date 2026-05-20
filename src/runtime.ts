import { execFileSync } from "child_process";
import os from "os";
import path from "path";

function prependPath(dir: string) {
  const parts = (process.env.PATH ?? "").split(path.delimiter);
  if (!parts.includes(dir)) {
    process.env.PATH = [dir, ...parts].filter(Boolean).join(path.delimiter);
  }
}

function hasGoogleWorkspaceConfig() {
  return Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID ||
      process.env.GOOGLE_OAUTH_CLIENT_SECRET ||
      process.env.GOOGLE_OAUTH_REFRESH_TOKEN ||
      process.env.GOOGLE_WORKSPACE_USER_EMAIL
  );
}

function hasUvx() {
  try {
    execFileSync("uvx", ["--version"], {
      env: process.env,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function ensureRuntimeDependencies() {
  prependPath(path.join(os.homedir(), ".local", "bin"));

  if (!hasGoogleWorkspaceConfig() || hasUvx()) {
    return;
  }

  console.log("[startup] installing uv for Google Workspace MCP");
  execFileSync("sh", ["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"], {
    env: process.env,
    stdio: "inherit",
  });

  if (!hasUvx()) {
    throw new Error("uvx installation completed but uvx is still unavailable");
  }
}
