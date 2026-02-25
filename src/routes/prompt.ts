import { Hono } from "hono";
import { runTask } from "../agent.js";

export const promptRoutes = new Hono();

promptRoutes.post("/prompt", async (c) => {
  const apiKey = process.env.COMPADRE_API_KEY;
  if (apiKey) {
    const auth = c.req.header("Authorization");
    if (auth !== `Bearer ${apiKey}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const prompt = body.prompt;
  if (!prompt || typeof prompt !== "string") {
    return c.json({ error: "missing 'prompt' field" }, 400);
  }

  console.log(`[prompt] received: ${prompt.slice(0, 100)}`);

  try {
    const result = await runTask({
      prompt,
      maxTurns: (body.maxTurns as number) ?? 30,
      maxBudgetUsd: (body.maxBudgetUsd as number) ?? 2.0,
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
