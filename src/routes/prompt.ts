import { Hono } from "hono";
import { DEFAULT_MAX_TURNS } from "../config.js";
import { runConversation } from "../conversation.js";
import { isAgentProvider } from "../tanstack/protocol.js";
import { requireCompadreApiKey } from "./auth.js";

export const promptRoutes = new Hono();

promptRoutes.post("/prompt", async (c) => {
  const authError = requireCompadreApiKey(c);
  if (authError) return authError;

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

  const threadId =
    typeof body.threadId === "string" ? body.threadId : undefined;
  const sessionId =
    typeof body.sessionId === "string" ? body.sessionId : undefined;
  const requestedProvider = body.provider;
  if (requestedProvider !== undefined && !isAgentProvider(requestedProvider)) {
    return c.json({ error: "provider must be 'claude-code' or 'codex'" }, 400);
  }
  if (sessionId) {
    return c.json(
      { error: "sessionId is provider-native; use threadId" },
      400
    );
  }

  const async = body.async === true;

  console.log(`[prompt] received (async=${async}): ${prompt.slice(0, 100)}`);

  const taskOptions = {
    prompt,
    threadId,
    provider: isAgentProvider(requestedProvider)
      ? requestedProvider
      : undefined,
    maxTurns: (body.maxTurns as number) ?? DEFAULT_MAX_TURNS,
    signal: async ? undefined : c.req.raw.signal,
  };

  if (async) {
    runConversation(taskOptions)
      .then((result) => {
        console.log(
          `[prompt] async completed: provider=${result.provider} turns=${result.numTurns} cost=$${result.costUsd.toFixed(3)} duration=${result.durationMs}ms`
        );
      })
      .catch((err) => {
        console.error("[prompt] async error:", err);
      });
    return c.json({ ok: true, message: "accepted" }, 202);
  }

  const result = await runConversation(taskOptions);
  return c.json({
    ok: true,
    result: result.result,
    sessionId: result.sessionId,
    provider: result.provider,
    model: result.model,
    turns: result.numTurns,
    cost: result.costUsd,
    duration: result.durationMs,
  });
});
