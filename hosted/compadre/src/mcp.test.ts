import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMcpServers,
  buildPostgresMcpServer,
  buildPostHogMcpServer,
} from "./mcp.js";

test("Postgres MCP keeps the database URL out of process arguments", () => {
  const databaseUrl = "postgres://secret-user:secret-password@db/test";
  const server = buildPostgresMcpServer(databaseUrl);

  assert.equal("type" in server, false);
  if ("type" in server) return;
  assert.equal(server.command, "node");
  assert.equal(server.args?.join(" ").includes(databaseUrl), false);
  assert.equal(server.env?.READONLY_DATABASE_URL, databaseUrl);
});

test("PostHog MCP defaults to the token-efficient write-capable connection", () => {
  const server = buildPostHogMcpServer("phx-secret");

  assert.ok("type" in server);
  if (!("type" in server)) return;
  assert.equal(server.type, "http");
  assert.equal(server.url, "https://mcp.posthog.com/mcp");
  assert.deepEqual(server.headers, {
    Authorization: "Bearer phx-secret",
    "x-posthog-mcp-mode": "cli",
    "x-posthog-organization-id": "01a0b018-1eb1-0000-7a15-6e0020552cdd",
    "x-posthog-project-id": "614600",
  });
});

test("PostHog MCP reads its controller configuration from the environment", async () => {
  const keys = [
    "POSTHOG_PERSONAL_API_KEY",
    "POSTHOG_MCP_URL",
    "POSTHOG_MCP_MODE",
    "COMPADRE_MCP_ALLOW_PARTIAL",
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.COMPADRE_MCP_ALLOW_PARTIAL = "true";
    process.env.POSTHOG_PERSONAL_API_KEY = "phx-controller-secret";
    process.env.POSTHOG_MCP_URL = "https://posthog.example/mcp";
    process.env.POSTHOG_MCP_MODE = "tools";
    const servers = await buildMcpServers();
    const server = servers.posthog;
    assert.ok(server && "type" in server);
    if (!server || !("type" in server)) return;
    assert.equal(server.url, "https://posthog.example/mcp");
    assert.deepEqual(server.headers, {
      Authorization: "Bearer phx-controller-secret",
      "x-posthog-mcp-mode": "tools",
      "x-posthog-organization-id": "01a0b018-1eb1-0000-7a15-6e0020552cdd",
      "x-posthog-project-id": "614600",
    });
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("partial MCP mode omits integrations without local credentials", async () => {
  const keys = [
    "SLACK_BOT_TOKEN",
    "SLACK_TEAM_ID",
    "LINEAR_MCP_ACCESS_TOKEN",
    "GITHUB_PERSONAL_ACCESS_TOKEN",
    "RENDER_API_KEY",
    "JAM_MCP_PAT",
    "POSTHOG_PERSONAL_API_KEY",
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const previousPartial = process.env.COMPADRE_MCP_ALLOW_PARTIAL;
  try {
    process.env.COMPADRE_MCP_ALLOW_PARTIAL = "true";
    for (const key of keys) delete process.env[key];

    const servers = await buildMcpServers();

    for (const name of [
      "slack",
      "linear",
      "github",
      "render",
      "jam",
      "posthog",
    ]) {
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

test("Comp MCP can use an app credential distinct from the relay API key", async () => {
  const keys = [
    "COMP_APP_URL",
    "COMP_APP_API_KEY",
    "COMPADRE_API_KEY",
    "COMPADRE_MCP_ALLOW_PARTIAL",
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.COMPADRE_MCP_ALLOW_PARTIAL = "true";
    process.env.COMP_APP_URL = "https://app.example.com";
    process.env.COMP_APP_API_KEY = "app-key";
    process.env.COMPADRE_API_KEY = "relay-key";

    const servers = await buildMcpServers();
    const server = servers.comp_app;
    assert.ok(server && "type" in server);
    if (!server || !("type" in server)) return;
    assert.equal(server.url, "https://app.example.com/api/mcp/compadre");
    assert.equal(server.headers?.Authorization, "Bearer app-key");
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Slack custom tools receive the durable store needed for deployment watches", async () => {
  const keys = [
    "SLACK_BOT_TOKEN",
    "SLACK_TEAM_ID",
    "COMPADRE_DURABILITY_DATABASE_URL",
    "COMPADRE_MCP_ALLOW_PARTIAL",
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.COMPADRE_MCP_ALLOW_PARTIAL = "true";
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_TEAM_ID = "T123";
    process.env.COMPADRE_DURABILITY_DATABASE_URL =
      "postgres://durable.example/compadre";

    const servers = await buildMcpServers();
    const slack = servers.slack;
    assert.ok(slack && "command" in slack);
    if (!slack || !("command" in slack)) return;
    assert.equal(slack.env?.SLACK_BOT_TOKEN, "xoxb-test");
    assert.equal(slack.env?.SLACK_TEAM_ID, "T123");
    assert.equal(
      slack.env?.COMPADRE_DURABILITY_DATABASE_URL,
      "postgres://durable.example/compadre",
    );
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
