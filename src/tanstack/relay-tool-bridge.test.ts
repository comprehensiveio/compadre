import assert from "node:assert/strict";
import test from "node:test";
import {
  createRelayToolBridgeProvisioner,
  dispatchRelayToolBridgeRequest,
} from "./relay-tool-bridge.js";

test("serves an authenticated run-scoped TanStack tool bridge", async () => {
  const provisioner = createRelayToolBridgeProvisioner({
    NODE_ENV: "test",
    COMPADRE_PUBLIC_URL: "http://relay.test",
  });
  const bridge = await provisioner.provision([], { provider: "daytona" });
  const bridgeId = new URL(bridge.url).pathname.split("/").at(-1);
  assert.ok(bridgeId);

  const unauthorized = await dispatchRelayToolBridgeRequest({
    bridgeId,
    authorization: "Bearer wrong",
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  assert.equal(unauthorized.status, 401);

  const listed = await dispatchRelayToolBridgeRequest({
    bridgeId,
    authorization: `Bearer ${bridge.token}`,
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  assert.deepEqual(listed, {
    status: 200,
    body: { jsonrpc: "2.0", id: 1, result: { tools: [] } },
  });

  await bridge.close();
  const closed = await dispatchRelayToolBridgeRequest({
    bridgeId,
    authorization: `Bearer ${bridge.token}`,
    body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
  });
  assert.equal(closed.status, 404);
});

test("advertises eagerly discovered host MCP tools to the sandbox", async () => {
  const provisioner = createRelayToolBridgeProvisioner({
    NODE_ENV: "test",
    COMPADRE_PUBLIC_URL: "http://relay.test",
  });
  let calls = 0;
  const bridge = await provisioner.provision(
    [
      {
        name: "render_list_services",
        description: "List Render services",
        inputSchema: { type: "object", properties: {} },
        execute: async () => {
          calls += 1;
          return { probe: "bridge-result" };
        },
      },
    ],
    { provider: "daytona" },
  );
  const bridgeId = new URL(bridge.url).pathname.split("/").at(-1);
  assert.ok(bridgeId);

  const listed = await dispatchRelayToolBridgeRequest({
    bridgeId,
    authorization: `Bearer ${bridge.token}`,
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  assert.equal(listed.status, 200);
  const listBody = listed.body as {
    result: { tools: Array<{ name: string }> };
  };
  assert.deepEqual(
    listBody.result.tools.map((tool) => tool.name),
    ["render_list_services"],
  );

  const called = await dispatchRelayToolBridgeRequest({
    bridgeId,
    authorization: `Bearer ${bridge.token}`,
    body: {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "render_list_services", arguments: {} },
    },
  });
  assert.equal(called.status, 200);
  assert.equal(calls, 1);
  assert.deepEqual(called.body, {
    jsonrpc: "2.0",
    id: 2,
    result: {
      content: [
        { type: "text", text: JSON.stringify({ probe: "bridge-result" }) },
      ],
    },
  });
  await bridge.close();
});

test("requires an HTTPS public relay origin outside tests", async () => {
  const provisioner = createRelayToolBridgeProvisioner({
    COMPADRE_PUBLIC_URL: "http://relay.example.com",
  });
  await assert.rejects(
    provisioner.provision([], { provider: "daytona" }),
    /must use HTTPS/,
  );
});
