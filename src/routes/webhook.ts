import { Hono } from "hono";
import { runTask } from "../agent.js";

export const webhookRoutes = new Hono();

/**
 * Generic webhook endpoint for forwarding events to the agent.
 *
 * Accepts arbitrary JSON payloads and constructs a prompt from them.
 * Useful for Datadog alerts, GitHub webhooks, Linear webhooks, etc.
 */
webhookRoutes.post("/webhook/:source", async (c) => {
  const source = c.req.param("source");
  const body = await c.req.json();

  console.log(`[webhook] received from ${source}`);

  const prompt = `You received a webhook event from ${source}. Analyze it and take appropriate action.

Source: ${source}
Payload:
${JSON.stringify(body, null, 2)}

Based on the source and payload, determine what action to take. For example:
- Datadog alert: investigate the issue using Datadog tools, check relevant code, post findings to Slack
- GitHub PR: review the changes, post feedback
- Linear update: check if any follow-up is needed`;

  // Process async
  runTask({ prompt, maxTurns: 25, maxBudgetUsd: 1.5 }).catch((err) =>
    console.error(`[webhook] ${source} task failed:`, err)
  );

  return c.json({ ok: true, source });
});
