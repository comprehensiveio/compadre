import assert from "node:assert/strict";
import test from "node:test";
import {
  createRelayToolBridgeProvisioner,
  dispatchEnvironmentToolBridgeRequest,
  MAX_BRIDGE_REQUEST_BYTES,
  scopedEnvironmentBridgeToken,
} from "../tanstack/relay-tool-bridge.js";
import { toolBridgeRoutes } from "./tool-bridge.js";

test("rejects an oversized declared bridge request before parsing", async () => {
  const response = await toolBridgeRoutes.request(
    "/internal/tanstack-tool-bridge/missing",
    {
      method: "POST",
      headers: {
        "Content-Length": String(MAX_BRIDGE_REQUEST_BYTES + 1),
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  assert.equal(response.status, 413);
});

test("byte-limits a chunked bridge request without Content-Length", async () => {
  const chunk = new Uint8Array(512 * 1024);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
      controller.enqueue(chunk);
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  });
  const request = new Request(
    "http://relay.test/internal/tanstack-tool-bridge/missing",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" },
  );
  const response = await toolBridgeRoutes.fetch(request);
  assert.equal(response.status, 413);
});

test("acknowledges MCP notifications with 202 and no response body", async () => {
  const bridge = await createRelayToolBridgeProvisioner({
    NODE_ENV: "test",
    COMPADRE_PUBLIC_URL: "http://relay.test",
  }).provision([], { provider: "modal" });
  const bridgeId = new URL(bridge.url).pathname.split("/").at(-1);
  assert.ok(bridgeId);

  try {
    const response = await toolBridgeRoutes.request(
      `/internal/tanstack-tool-bridge/${bridgeId}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bridge.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      },
    );

    assert.equal(response.status, 202);
    assert.equal(await response.text(), "");
  } finally {
    await bridge.close();
  }
});

test("protects the environment bridge and dispatches MCP messages", async () => {
  const core = {
    listTools: () => [
      {
        name: "slack_watch_comp_pr_deployment",
        description: "Watch a deployment",
        inputSchema: { type: "object" as const, properties: {} },
      },
    ],
    callTool: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
  };
  const environment = { COMPADRE_T3_MCP_BEARER_TOKEN: "environment-token" };

  assert.deepEqual(
    await dispatchEnvironmentToolBridgeRequest({
      authorization: "Bearer wrong-token",
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      environment,
      core,
    }),
    { status: 401, body: { error: "unauthorized" } },
  );

  const result = await dispatchEnvironmentToolBridgeRequest({
    authorization: "Bearer environment-token",
    body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
    environment,
    core,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    jsonrpc: "2.0",
    id: 2,
    result: { tools: core.listTools() },
  });
});

test("blocks direct final delivery to the bound Slack thread", async () => {
  let called = false;
  const core = {
    listTools: () => [],
    callTool: async () => {
      called = true;
      return { content: [{ type: "text" as const, text: "unexpected" }] };
    },
  };
  const result = await dispatchEnvironmentToolBridgeRequest({
    authorization: `Bearer ${scopedEnvironmentBridgeToken("environment-token", {
      channelId: "C123",
      threadTs: "123.456",
    })}`,
    environment: { COMPADRE_T3_MCP_BEARER_TOKEN: "environment-token" },
    blockedSlackDestination: { channelId: "C123", threadTs: "123.456" },
    body: {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "slack_reply_to_thread",
        arguments: {
          channel_id: "C123",
          thread_ts: "123.456",
          text: "duplicate",
        },
      },
    },
    core,
  });
  assert.equal(result.status, 200);
  assert.equal(called, false);
  assert.deepEqual(result.body, {
    jsonrpc: "2.0",
    id: 7,
    result: {
      content: [
        {
          type: "text",
          text: "Compadre owns final delivery for this Slack thread; return the final answer normally instead of posting it with a Slack tool.",
        },
      ],
      isError: true,
    },
  });

  assert.deepEqual(
    await dispatchEnvironmentToolBridgeRequest({
      authorization: `Bearer ${scopedEnvironmentBridgeToken(
        "environment-token",
        { channelId: "C123", threadTs: "123.456" },
      )}`,
      environment: { COMPADRE_T3_MCP_BEARER_TOKEN: "environment-token" },
      body: { jsonrpc: "2.0", id: 8, method: "tools/list" },
      core,
    }),
    { status: 401, body: { error: "unauthorized" } },
  );
});
