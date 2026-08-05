import assert from "node:assert/strict";
import test from "node:test";
import { mcpClientIdentity } from "./mcp.js";

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
