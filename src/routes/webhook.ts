import { Hono } from "hono";
import { runConversation } from "../conversation.js";
import { requireCompadreApiKey } from "./auth.js";

export const webhookRoutes = new Hono();

webhookRoutes.post("/webhook/:source", async (c) => {
  const authError = requireCompadreApiKey(c);
  if (authError) return authError;

  const source = c.req.param("source");

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  console.log(`[webhook] received from ${source}`);

  const prompt = `You received a webhook event from ${source}. Analyze it and take appropriate action.

Source: ${source}
Payload:
${JSON.stringify(body, null, 2)}

Based on the source and payload, determine what action to take. For example:
- Datadog alert: investigate the issue using Datadog tools, check relevant code, post findings to Slack
- GitHub PR: review the changes, post feedback
- Linear update: check if any follow-up is needed`;

  runConversation({
    prompt,
    capacityPriority: "background",
    retryOnBackgroundPreemption: true,
  }).catch((err) =>
    console.error(`[webhook] ${source} task failed:`, err)
  );

  return c.json({ ok: true, source });
});
