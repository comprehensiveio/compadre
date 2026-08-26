import assert from "node:assert/strict";
import test from "node:test";
import { buildMcpServers, buildPostgresMcpServer } from "./mcp.js";

test("Postgres MCP keeps the database URL out of process arguments", () => {
  const databaseUrl = "postgres://secret-user:secret-password@db/test";
  const server = buildPostgresMcpServer(databaseUrl);

  assert.equal("type" in server, false);
  if ("type" in server) return;
  assert.equal(server.command, "node");
  assert.equal(server.args?.join(" ").includes(databaseUrl), false);
  assert.equal(server.env?.READONLY_DATABASE_URL, databaseUrl);
});

test("partial MCP mode omits integrations without local credentials", async () => {
  const keys = [
    "SLACK_BOT_TOKEN",
    "SLACK_TEAM_ID",
    "LINEAR_MCP_ACCESS_TOKEN",
    "GITHUB_PERSONAL_ACCESS_TOKEN",
    "RENDER_API_KEY",
    "JAM_MCP_PAT",
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const previousPartial = process.env.COMPADRE_MCP_ALLOW_PARTIAL;
  try {
    process.env.COMPADRE_MCP_ALLOW_PARTIAL = "true";
    for (const key of keys) delete process.env[key];

    const servers = await buildMcpServers();

    for (const name of ["slack", "linear", "github", "render", "jam"]) {
      assert.equal(name in servers, false);
    }
  } finally {
    if (previousPartial === undefined) {
      delete process.env.COMPADRE_MCP_ALLOW_PARTIAL;
    } else {
      process.env.COMPADRE_MCP_ALLOW_PARTIAL = previousPartial;
    }
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
