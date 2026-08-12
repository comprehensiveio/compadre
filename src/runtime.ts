import { execFileSync } from "child_process";
import { existsSync } from "fs";
import os from "os";
import path from "path";

const WORKFLOW_RUNTIME_RELATIVE_PATH = path.join(
  ".workflow-cache",
  "runtime",
);

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

/**
 * Prefer dependencies baked into the Workflow image. The uv tool directories
 * match the build-time configuration, while the MCP subprocess invokes the
 * installed workspace-mcp executable directly with no runtime resolution.
 */
export function configureBundledWorkflowRuntime(
  runtimeRoot = path.resolve(WORKFLOW_RUNTIME_RELATIVE_PATH),
): boolean {
  const binDir = path.join(runtimeRoot, "bin");
  if (!existsSync(path.join(binDir, "workspace-mcp"))) {
    return false;
  }

  if (!process.env.WORKSPACE_MCP_EXECUTABLE?.trim()) {
    process.env.WORKSPACE_MCP_EXECUTABLE = path.join(binDir, "workspace-mcp");
  }
  prependPath(binDir);
  return true;
}

export function ensureRuntimeDependencies() {
  const hasBundledWorkspaceMcp = configureBundledWorkflowRuntime();
  prependPath(path.join(os.homedir(), ".local", "bin"));

  if (!hasGoogleWorkspaceConfig() || hasBundledWorkspaceMcp || hasUvx()) {
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
