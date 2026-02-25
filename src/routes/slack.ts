import { Hono } from "hono";
import { runTask } from "../agent.js";
import { SLACK_SYSTEM_PROMPT } from "../prompts/index.js";

export const slackRoutes = new Hono();

const threadSessions = new Map<string, string>();

slackRoutes.post("/slack", async (c) => {
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

  const message = body.message;
  if (!message || typeof message !== "string") {
    return c.json({ error: "missing 'message' field" }, 400);
  }

  const channel = body.channel as string | undefined;
  const threadTs = body.threadTs as string | undefined;
  const userId = body.userId as string | undefined;

  if (!channel) {
    return c.json({ error: "missing 'channel' field" }, 400);
  }

  const threadKey = threadTs || `${channel}-${Date.now()}`;
  const sessionId = threadSessions.get(threadKey);

  const prompt = buildSlackPrompt({ message, channel, threadTs, userId });

  console.log(`[slack] received from ${userId} in ${channel}: ${message.slice(0, 100)}`);

  // Fire and forget — respond 202 immediately
  runTask({
    prompt,
    sessionId,
    systemPrompt: SLACK_SYSTEM_PROMPT,
    maxTurns: (body.maxTurns as number) ?? 50,
    maxBudgetUsd: (body.maxBudgetUsd as number) ?? 3.0,
  })
    .then((result) => {
      if (result.sessionId) {
        threadSessions.set(threadKey, result.sessionId);
      }
      console.log(
        `[slack] completed for ${userId}: turns=${result.numTurns} cost=$${result.costUsd.toFixed(3)} duration=${result.durationMs}ms`
      );
    })
    .catch((err) => {
      console.error(`[slack] agent error for ${userId}:`, err);
    });

  return c.json({ ok: true, message: "accepted" }, 202);
});

function buildSlackPrompt({
  message,
  channel,
  threadTs,
  userId,
}: {
  message: string;
  channel: string;
  threadTs?: string;
  userId?: string;
}) {
  const parts = [
    `A user${userId ? ` (Slack user ID: ${userId})` : ""} sent you this message via Slack.`,
    `Respond in Slack channel ${channel}${threadTs ? ` in thread ${threadTs}` : ""} using the Slack MCP.`,
    `Do NOT return a text response — post your answer directly to Slack.`,
    ``,
    `Their message:`,
    message,
  ];
  return parts.join("\n");
}
