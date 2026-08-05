import type { Context } from "hono";

/** Require the shared Compadre API key without failing open on misconfiguration. */
export function requireCompadreApiKey(c: Context): Response | null {
  const apiKey = process.env.COMPADRE_API_KEY;
  if (!apiKey) {
    return c.json({ error: "COMPADRE_API_KEY is not configured" }, 503);
  }
  if (c.req.header("Authorization") !== `Bearer ${apiKey}`) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return null;
}
