import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configureBundledWorkflowRuntime } from "./runtime.js";

test("selects a baked Workspace MCP without requiring uv at runtime", () => {
  const runtimeRoot = mkdtempSync(
    path.join(os.tmpdir(), "compadre-workflow-runtime-"),
  );
  const binDir = path.join(runtimeRoot, "bin");
  mkdirSync(binDir);
  writeFileSync(path.join(binDir, "workspace-mcp"), "");
  const previousPath = process.env.PATH;
  const previousExecutable = process.env.WORKSPACE_MCP_EXECUTABLE;

  try {
    delete process.env.WORKSPACE_MCP_EXECUTABLE;
    assert.equal(configureBundledWorkflowRuntime(runtimeRoot), true);
    assert.equal(
      process.env.WORKSPACE_MCP_EXECUTABLE,
      path.join(binDir, "workspace-mcp"),
    );
    assert.equal(process.env.PATH?.split(path.delimiter)[0], binDir);
  } finally {
    process.env.PATH = previousPath;
    if (previousExecutable === undefined) {
      delete process.env.WORKSPACE_MCP_EXECUTABLE;
    } else {
      process.env.WORKSPACE_MCP_EXECUTABLE = previousExecutable;
    }
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("ignores incomplete baked runtimes", () => {
  const runtimeRoot = mkdtempSync(
    path.join(os.tmpdir(), "compadre-workflow-runtime-"),
  );
  try {
    assert.equal(configureBundledWorkflowRuntime(runtimeRoot), false);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
