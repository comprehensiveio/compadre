import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const UV_VERSION = "0.12.3";
const WORKSPACE_MCP_VERSION = "1.23.1";
const runtimeRoot = path.resolve(".workflow-cache", "runtime");
const binDir = path.join(runtimeRoot, "bin");
const toolDir = path.join(runtimeRoot, "tools");
const cacheDir = path.join(runtimeRoot, "cache");
const uvInstaller = path.join(runtimeRoot, "install-uv.sh");

rmSync(runtimeRoot, { recursive: true, force: true });
mkdirSync(binDir, { recursive: true });

const installEnvironment = {
  ...process.env,
  UV_UNMANAGED_INSTALL: binDir,
  UV_NO_MODIFY_PATH: "1",
};
execFileSync(
  "curl",
  [
    "-LsSf",
    `https://astral.sh/uv/${UV_VERSION}/install.sh`,
    "-o",
    uvInstaller,
  ],
  { stdio: "inherit" },
);
execFileSync("sh", [uvInstaller], {
  env: installEnvironment,
  stdio: "inherit",
});
rmSync(uvInstaller, { force: true });

if (!existsSync(path.join(binDir, "uv"))) {
  throw new Error(`uv ${UV_VERSION} was not installed into ${binDir}`);
}

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

// Task instances invoke the installed executable directly. Exclude the build
// resolver and its package cache from the immutable Workflow image.
rmSync(cacheDir, { recursive: true, force: true });
rmSync(path.join(binDir, "uv"), { force: true });
rmSync(path.join(binDir, "uvx"), { force: true });

console.log(
  JSON.stringify({
    event: "workflow.runtime-prepared",
    runtimeRoot,
    uvVersion: UV_VERSION,
    workspaceMcpVersion: WORKSPACE_MCP_VERSION,
  }),
);
