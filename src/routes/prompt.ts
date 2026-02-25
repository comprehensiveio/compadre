import { Hono } from "hono";
import { runTask } from "../agent.js";

export const promptRoutes = new Hono();

/**
 * Direct prompt endpoint for interacting with the agent via curl.
 *
 * Usage:
 *   curl -X POST http://localhost:3100/prompt \
 *     -H "Authorization: Bearer $COMPADRE_API_KEY" \
 *     -H "Content-Type: application/json" \
 *     -d '{"prompt": "Check Datadog for any active alerts"}'
 */
promptRoutes.post("/prompt", async (c) => {
  const apiKey = process.env.COMPADRE_API_KEY;
  if (apiKey) {
    const auth = c.req.header("Authorization");
    if (auth !== `Bearer ${apiKey}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
  }

  const body = await c.req.json();
  const prompt = body.prompt;

  if (!prompt || typeof prompt !== "string") {
    return c.json({ error: "missing 'prompt' field" }, 400);
  }

  console.log(`[prompt] received: ${prompt.slice(0, 100)}`);

  try {
    const result = await runTask({
      prompt,
      maxTurns: body.maxTurns ?? 30,
      maxBudgetUsd: body.maxBudgetUsd ?? 2.0,
    });

    return c.json({
      ok: true,
      result: result.result,
      turns: result.numTurns,
      cost: result.costUsd,
      duration: result.durationMs,
    });
  } catch (err) {
    console.error("[prompt] agent error:", err);
    return c.json(
      { ok: false, error: err instanceof Error ? err.message : "unknown" },
      500
    );
  }
});
