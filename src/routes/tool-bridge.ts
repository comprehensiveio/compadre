import { Hono } from "hono";
import {
  dispatchRelayToolBridgeRequest,
  MAX_BRIDGE_REQUEST_BYTES,
} from "../tanstack/relay-tool-bridge.js";

export const toolBridgeRoutes = new Hono();

async function readLimitedJson(
  request: Request,
): Promise<
  { status: 200; body: unknown } | { status: 400 } | { status: 413 }
> {
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_BRIDGE_REQUEST_BYTES
  ) {
    return { status: 413 };
  }

  const reader = request.body?.getReader();
  if (!reader) return { status: 400 };
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BRIDGE_REQUEST_BYTES) {
        await reader.cancel("request too large");
        return { status: 413 };
      }
      chunks.push(value);
    }
  } catch {
    return { status: 400 };
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { status: 200, body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { status: 400 };
  }
}

toolBridgeRoutes.post("/internal/tanstack-tool-bridge/:bridgeId", async (c) => {
  const parsed = await readLimitedJson(c.req.raw);
  if (parsed.status === 413) {
    return c.json({ error: "request too large" }, 413);
  }
  if (parsed.status === 400) {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const result = await dispatchRelayToolBridgeRequest({
    bridgeId: c.req.param("bridgeId"),
    authorization: c.req.header("Authorization"),
    contentLength: c.req.header("Content-Length"),
    body: parsed.body,
  });
  if (result.body === null) return c.body(null, result.status);
  return c.json(result.body, result.status);
});
