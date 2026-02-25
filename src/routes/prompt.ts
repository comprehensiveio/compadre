import { Hono } from "hono";
import { runTask } from "../agent.js";
import { getSessionId, setSessionId } from "../sessions.js";

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

  const threadId = body.threadId as string | undefined;
  let sessionId: string | undefined = (body.sessionId as string) ?? undefined;

  if (!sessionId && threadId) {
    sessionId = getSessionId(threadId);
  }

  console.log(`[prompt] received: ${prompt.slice(0, 100)}`);

  try {
    const result = await runTask({
      prompt,
      sessionId,
      maxTurns: (body.maxTurns as number) ?? 30,
      maxBudgetUsd: (body.maxBudgetUsd as number) ?? 2.0,
    });

    if (threadId && result.sessionId) {
      setSessionId(threadId, result.sessionId);
    }

    return c.json({
      ok: true,
      result: result.result,
      sessionId: result.sessionId,
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
