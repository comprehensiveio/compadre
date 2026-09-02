import assert from "node:assert/strict";
import test from "node:test";
import type { SandboxHandle } from "@tanstack/ai-sandbox";
import {
  collectT3OutputArtifacts,
  T3_OUTPUT_ARTIFACT_DIR,
} from "./output-artifacts.js";

function sandbox(files: Record<string, Uint8Array>): SandboxHandle {
  const markers = new Map<string, Uint8Array>();
  return {
    id: "sandbox-1",
    provider: "test",
    capabilities: {} as SandboxHandle["capabilities"],
    fs: {
      async exists(path) {
        return path === T3_OUTPUT_ARTIFACT_DIR || path === "/tmp/compadre-output-markers" || markers.has(path);
      },
      async list(path) {
        if (path !== T3_OUTPUT_ARTIFACT_DIR) return [];
        return Object.keys(files).map((name) => ({
          name,
          path: `${T3_OUTPUT_ARTIFACT_DIR}/${name}`,
          type: "file" as const,
        }));
      },
      async readBytes(path) {
        const name = path.slice(`${T3_OUTPUT_ARTIFACT_DIR}/`.length);
        const value = files[name] ?? markers.get(path);
        if (!value) throw new Error(`missing ${path}`);
        return value;
      },
      async write(path, data) {
        markers.set(path, typeof data === "string" ? new TextEncoder().encode(data) : data);
      },
      async mkdir() {},
      async read() { throw new Error("unused"); },
      async remove() {},
      async rename() {},
    },
    process: {
      async exec(command) {
        const path = Object.keys(files).find((name) => command.includes(`/${name}'`));
        return path
          ? { stdout: `${files[path]!.byteLength} 1\n`, stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "", exitCode: 1 };
      },
      async spawn() { throw new Error("unused"); },
    },
    git: {} as SandboxHandle["git"],
    ports: {} as SandboxHandle["ports"],
    env: {} as SandboxHandle["env"],
    async destroy() {},
  };
}

test("collects safe output files once and identifies their content", async () => {
  const handle = sandbox({
    "proof.png": Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ".secret": Uint8Array.from([1]),
  });
  const artifacts: Array<{ path: string; mimetype: string }> = [];

  const first = await collectT3OutputArtifacts(handle, async (artifact) => {
    artifacts.push({ path: artifact.path, mimetype: artifact.mimetype });
  });
  const second = await collectT3OutputArtifacts(handle, async () => {
    throw new Error("already published artifact was republished");
  });

  assert.deepEqual(first.failures, []);
  assert.equal(first.published.length, 1);
  assert.deepEqual(artifacts, [{ path: "proof.png", mimetype: "image/png" }]);
  assert.deepEqual(second, first);
});
