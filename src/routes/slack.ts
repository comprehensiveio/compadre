import crypto from "crypto";
import { Hono } from "hono";
import { runTask } from "../agent.js";
import { DEFAULT_MAX_TURNS, DEFAULT_MAX_BUDGET_USD } from "../config.js";
import { getSlackSystemPrompt, getSlackStreamingSystemPrompt } from "../prompts/index.js";
import { createWorktree, removeWorktree } from "../repo.js";
import { getSession, setSession } from "../sessions.js";
import { SlackStream } from "../services/slack-stream.js";
import { humanizeToolName } from "../services/tool-labels.js";

export const slackRoutes = new Hono();

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
  const existing = getSession(threadKey);
  const sessionId = existing?.sessionId;
  const worktreeId = existing?.worktreeId ?? crypto.randomUUID();
  const worktreePath = createWorktree(worktreeId);

  const prompt = buildSlackPrompt({ message, channel, threadTs, userId });

  console.log(`[slack] received from ${userId} in ${channel}: ${message.slice(0, 100)}`);

  let slackStream: SlackStream | undefined;
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (threadTs && botToken) {
    slackStream = new SlackStream({ channel, threadTs, botToken });
  }

  // Fire and forget — respond 202 immediately
  runTask({
    prompt,
    sessionId,
    systemPrompt: slackStream ? getSlackStreamingSystemPrompt(worktreePath) : getSlackSystemPrompt(worktreePath),
    worktreePath,
    maxTurns: (body.maxTurns as number) ?? DEFAULT_MAX_TURNS,
    maxBudgetUsd: (body.maxBudgetUsd as number) ?? DEFAULT_MAX_BUDGET_USD,
    stream: slackStream
      ? {
          onTextDelta: (text) => void slackStream!.appendText(text),
          onToolStart: (name) => void slackStream!.setStatus(humanizeToolName(name) + "..."),
          onComplete: () => {
            void slackStream!.stopStream();
            void slackStream!.clearStatus();
          },
        }
      : undefined,
  })
    .then(async (result) => {
      if (result.sessionId) {
        setSession(threadKey, { sessionId: result.sessionId, worktreeId });
      }
      removeWorktree(worktreeId);
      console.log(
        `[slack] completed for ${userId}: turns=${result.numTurns} cost=$${result.costUsd.toFixed(3)} duration=${result.durationMs}ms`
      );
    })
    .catch(async (err) => {
      console.error(`[slack] agent error for ${userId}:`, err);
      removeWorktree(worktreeId);
      if (slackStream) {
        await slackStream.stopStream();
        await slackStream.clearStatus();
      }
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
  const lines = [
    `Slack message from user ${userId || "unknown"}.`,
    ``,
    `Reply to:`,
    `- channel: ${channel}`,
    threadTs ? `- thread_ts: ${threadTs} (reply in this thread)` : `- no thread (start a new message)`,
    ``,
    message,
  ];
  return lines.join("\n");
}
