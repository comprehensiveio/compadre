import { Hono } from "hono";
import { runTask } from "../agent.js";
import { DEFAULT_MAX_TURNS, DEFAULT_MAX_BUDGET_USD } from "../config.js";

export const promptRoutes = new Hono();

const threadSessions = new Map<string, string>();

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
    sessionId = threadSessions.get(threadId);
  }

  console.log(`[prompt] received: ${prompt.slice(0, 100)}`);

  const result = await runTask({
    prompt,
    sessionId,
    maxTurns: (body.maxTurns as number) ?? DEFAULT_MAX_TURNS,
    maxBudgetUsd: (body.maxBudgetUsd as number) ?? DEFAULT_MAX_BUDGET_USD,
  });

  if (threadId && result.sessionId) {
    threadSessions.set(threadId, result.sessionId);
  }

  return c.json({
    ok: true,
    result: result.result,
    sessionId: result.sessionId,
    turns: result.numTurns,
    cost: result.costUsd,
    duration: result.durationMs,
  });
});
