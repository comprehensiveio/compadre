import assert from "node:assert/strict";
import test from "node:test";
import type { MCPClient } from "@tanstack/ai-mcp";
import { discoverHarnessMcpTools, mcpClientIdentity } from "./mcp.js";

test("gives every MCP server a stable tool-name prefix", () => {
  assert.deepEqual(mcpClientIdentity("github"), {
    name: "compadre-github",
    prefix: "github",
  });
  assert.deepEqual(mcpClientIdentity("datadog-mcp"), {
    name: "compadre-datadog-mcp",
    prefix: "datadog_mcp",
  });
  assert.notEqual(
    mcpClientIdentity("linear").prefix,
    mcpClientIdentity("github").prefix
  );
});

function clientWithTools(names: string[]): MCPClient {
  return {
    tools: async () =>
      names.map((name) => ({
        name,
        description: `${name} description`,
        inputSchema: { type: "object", properties: {} },
        execute: async () => ({ ok: true }),
        metadata: { mcp: { title: name } },
      })),
  } as unknown as MCPClient;
}

test("discovers host MCP tools before the sandbox bridge starts", async () => {
  const tools = await discoverHarnessMcpTools([
    clientWithTools(["render_list_services"]),
    clientWithTools(["slack_search"]),
  ]);

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["render_list_services", "slack_search"],
  );
});

test("removes the redundant Slack prefix from legacy Slack MCP tool names", async () => {
  const tools = await discoverHarnessMcpTools([
    clientWithTools([
      "slack_slack_upload_file",
      "slack_slack_reply_to_thread",
      "slack_watch_comp_pr_deployment",
    ]),
  ]);

  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "slack_upload_file",
      "slack_reply_to_thread",
      "slack_watch_comp_pr_deployment",
    ],
  );
});

test("rejects duplicate host MCP tool names before provisioning", async () => {
  await assert.rejects(
    discoverHarnessMcpTools([
      clientWithTools(["render_list_services"]),
      clientWithTools(["render_list_services"]),
    ]),
    /Duplicate MCP tool name: render_list_services/,
  );
});
