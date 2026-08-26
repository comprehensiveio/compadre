import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import type { AnyServerTool } from "@tanstack/ai";
import { withSandboxFileToolCompatibility } from "./sandbox-tool-compat.js";

test("materializes a Modal-local Slack upload path for its host-side MCP tool", async () => {
  let delegatedPath = "";
  const tools: AnyServerTool[] = [
    {
      __toolSide: "server",
      name: "slack_upload_file",
      description: "upload",
      inputSchema: { type: "object", properties: {} },
      async execute(args: { file_path: string }) {
        delegatedPath = args.file_path;
        return {
          body: await fs.readFile(args.file_path, "utf8"),
          mode: (await fs.stat(args.file_path)).mode & 0o777,
        };
      },
    },
  ];
  const [upload] = withSandboxFileToolCompatibility(tools, async (filePath) => {
    assert.equal(filePath, "/workspace/report.csv");
    return new TextEncoder().encode("service,status\napi,healthy\n");
  });

  const result = await upload!.execute?.({
    channel_id: "C123",
    thread_ts: "1712345678.000100",
    file_path: "/workspace/report.csv",
  });

  assert.deepEqual(result, {
    body: "service,status\napi,healthy\n",
    mode: 0o600,
  });
  await assert.rejects(fs.stat(delegatedPath), /ENOENT/);
});

test("leaves tools without sandbox-local file arguments unchanged", () => {
  const tool: AnyServerTool = {
    __toolSide: "server",
    name: "slack_watch_comp_pr_deployment",
    description: "watch",
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({ ok: true }),
  };

  assert.equal(
    withSandboxFileToolCompatibility([tool], async () => new Uint8Array())[0],
    tool,
  );
});
