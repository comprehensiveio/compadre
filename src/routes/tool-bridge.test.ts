import assert from "node:assert/strict";
import test from "node:test";
import { MAX_BRIDGE_REQUEST_BYTES } from "../tanstack/relay-tool-bridge.js";
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
