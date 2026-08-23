import { Hono } from "hono";
import { dispatchRelayToolBridgeRequest } from "../tanstack/relay-tool-bridge.js";

export const toolBridgeRoutes = new Hono();

toolBridgeRoutes.post("/internal/tanstack-tool-bridge/:bridgeId", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const result = await dispatchRelayToolBridgeRequest({
    bridgeId: c.req.param("bridgeId"),
    authorization: c.req.header("Authorization"),
    contentLength: c.req.header("Content-Length"),
    body,
  });
  if (result.body === null) return c.body(null, result.status);
  return c.json(result.body, result.status);
});
