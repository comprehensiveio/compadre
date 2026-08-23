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

test("requires an HTTPS public relay origin outside tests", async () => {
  const provisioner = createRelayToolBridgeProvisioner({
    COMPADRE_PUBLIC_URL: "http://relay.example.com",
  });
  await assert.rejects(
    provisioner.provision([], { provider: "daytona" }),
    /must use HTTPS/,
  );
});
