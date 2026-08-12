import assert from "node:assert/strict";
import test from "node:test";
import { buildPostgresMcpServer } from "./mcp.js";

test("Postgres MCP keeps the database URL out of process arguments", () => {
  const databaseUrl = "postgres://secret-user:secret-password@db/test";
  const server = buildPostgresMcpServer(databaseUrl);

  assert.equal("type" in server, false);
  if ("type" in server) return;
  assert.equal(server.command, "node");
  assert.equal(server.args?.join(" ").includes(databaseUrl), false);
  assert.equal(server.env?.READONLY_DATABASE_URL, databaseUrl);
});
