import assert from "node:assert/strict";
import test from "node:test";
import {
  createRelayToolBridgeProvisioner,
  MAX_BRIDGE_REQUEST_BYTES,
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
