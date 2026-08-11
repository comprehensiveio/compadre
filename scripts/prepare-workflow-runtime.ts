import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const UV_VERSION = "0.12.3";
const WORKSPACE_MCP_VERSION = "1.23.1";
const runtimeRoot = path.resolve(".workflow-cache", "runtime");
const binDir = path.join(runtimeRoot, "bin");
const toolDir = path.join(runtimeRoot, "tools");
const cacheDir = path.join(runtimeRoot, "cache");

rmSync(runtimeRoot, { recursive: true, force: true });
mkdirSync(binDir, { recursive: true });

const installEnvironment = {
  ...process.env,
  UV_UNMANAGED_INSTALL: binDir,
  UV_NO_MODIFY_PATH: "1",
};
execFileSync(
  "sh",
  ["-c", `curl -LsSf https://astral.sh/uv/${UV_VERSION}/install.sh | sh`],
  { env: installEnvironment, stdio: "inherit" },
);

const toolEnvironment = {
  ...process.env,
  PATH: [binDir, process.env.PATH].filter(Boolean).join(path.delimiter),
  UV_TOOL_DIR: toolDir,
  UV_TOOL_BIN_DIR: binDir,
  UV_CACHE_DIR: cacheDir,
};
execFileSync(
  path.join(binDir, "uv"),
  [
    "tool",
    "install",
    "--compile-bytecode",
    `workspace-mcp==${WORKSPACE_MCP_VERSION}`,
  ],
  { env: toolEnvironment, stdio: "inherit" },
);

console.log(
  JSON.stringify({
    event: "workflow.runtime-prepared",
    runtimeRoot,
    uvVersion: UV_VERSION,
    workspaceMcpVersion: WORKSPACE_MCP_VERSION,
  }),
);
