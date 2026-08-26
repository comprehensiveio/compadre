import crypto from "node:crypto";
import { Hono } from "hono";
import { runConversation } from "../conversation.js";
import { isAgentProvider } from "../tanstack/protocol.js";
import { requireCompadreApiKey } from "./auth.js";
import {
  nativeT3ApiEnabled,
  runT3SlackConversation,
} from "../services/t3-slack-conversation.js";
import { getConfiguredT3Gateway } from "../t3/runtime.js";

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

  if (nativeT3ApiEnabled()) {
    const canonicalThreadId = threadId ?? `api:${crypto.randomUUID()}`;
    const startedAt = Date.now();
    const execute = getConfiguredT3Gateway().then(async (gateway) => {
      if (!gateway) {
        throw new Error("Native T3 API requires durable thread persistence.");
      }
      return runT3SlackConversation({
        gateway,
        canonicalThreadId,
        title: prompt.slice(0, 200),
        prompt,
        displayText: prompt,
        profile:
          requestedProvider === "codex"
            ? "codex"
            : requestedProvider === "claude-code"
              ? "claude-code"
              : undefined,
        signal: async ? undefined : c.req.raw.signal,
        includeDetailsLink: !async,
      });
    });

    if (async) {
      void execute
        .then((result) => {
          console.log(
            `[prompt] native T3 async completed: thread=${canonicalThreadId} provider=${result.modelSelection.instanceId} model=${result.modelSelection.model}`,
          );
        })
        .catch((error) => console.error("[prompt] native T3 async error:", error));
      return c.json({ ok: true, message: "accepted", threadId: canonicalThreadId }, 202);
    }

    const result = await execute;
    return c.json({
      ok: true,
      result: result.output,
      sessionId: result.turn.binding.t3ThreadId,
      threadId: canonicalThreadId,
      provider:
        result.modelSelection.instanceId === "codex" ? "codex" : "claude-code",
      model: result.modelSelection.model,
      turns: 1,
      cost: 0,
      duration: Date.now() - startedAt,
      detailsUrl: result.detailsUrl,
    });
  }

  const taskOptions = {
    prompt,
    threadId,
    provider: isAgentProvider(requestedProvider)
      ? requestedProvider
      : undefined,
    signal: async ? undefined : c.req.raw.signal,
    capacityPriority: async ? ("background" as const) : ("foreground" as const),
    retryOnBackgroundPreemption: async,
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
