import { Hono } from "hono";
import { runTask } from "../agent.js";
import { taskPrompts } from "../prompts/index.js";

export const cronRoutes = new Hono();

/**
 * Cron endpoints — triggered by Render Cron Jobs or external scheduler.
 *
 * Each endpoint triggers an agent session with a task-specific prompt.
 * Protected by a shared secret in the Authorization header.
 */

cronRoutes.use("/*", async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const expected = process.env.CRON_SECRET;

  if (expected && authHeader !== `Bearer ${expected}`) {
    return c.json({ error: "unauthorized" }, 401);
  }

  await next();
});

cronRoutes.post("/cron/health-check", async (c) => {
  console.log("[cron] starting health check");

  try {
    const result = await runTask({
      prompt: taskPrompts.cronHealthCheck(),
      maxTurns: 30,
      maxBudgetUsd: 2.0,
    });

    return c.json({
      ok: true,
      turns: result.numTurns,
      cost: result.costUsd,
      duration: result.durationMs,
    });
  } catch (err) {
    console.error("[cron] health check failed:", err);
    return c.json(
      { ok: false, error: err instanceof Error ? err.message : "unknown" },
      500
    );
  }
});

cronRoutes.post("/cron/stale-tickets", async (c) => {
  console.log("[cron] starting stale ticket review");

  try {
    const result = await runTask({
      prompt: taskPrompts.cronStaleTickets(),
      maxTurns: 30,
      maxBudgetUsd: 2.0,
    });

    return c.json({
      ok: true,
      turns: result.numTurns,
      cost: result.costUsd,
      duration: result.durationMs,
    });
  } catch (err) {
    console.error("[cron] stale ticket review failed:", err);
    return c.json(
      { ok: false, error: err instanceof Error ? err.message : "unknown" },
      500
    );
  }
});
