import crypto from "crypto";
import { Hono } from "hono";
import { runTask } from "../agent.js";
import { DEFAULT_MAX_TURNS, DEFAULT_MAX_BUDGET_USD } from "../config.js";
import { getSlackSystemPrompt, getSlackStreamingSystemPrompt } from "../prompts/index.js";
import { createWorktree, removeWorktree } from "../repo.js";
import { getSession, setSession } from "../sessions.js";
import { resolveSlackChannelName } from "../services/slack-context.js";
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
  const sentChannelName =
    typeof body.channelName === "string" ? body.channelName : undefined;

  if (!channel) {
    return c.json({ error: "missing 'channel' field" }, 400);
  }

  const threadKey = threadTs || `${channel}-${Date.now()}`;
  const existing = getSession(threadKey);
  const sessionId = existing?.sessionId;
  const worktreeId = existing?.worktreeId ?? crypto.randomUUID();
  const worktreePath = createWorktree(worktreeId);

  const botToken = process.env.SLACK_BOT_TOKEN;
  const channelName =
    normalizeChannelName(sentChannelName) ||
    (botToken
      ? await resolveSlackChannelName({ channel, userId, botToken })
      : undefined);
  const prompt = buildSlackPrompt({
    message,
    channel,
    channelName: channelName || undefined,
    threadTs,
    userId,
  });

  console.log(`[slack] received from ${userId} in ${channel}: ${message.slice(0, 100)}`);

  let slackStream: SlackStream | undefined;
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
      } else {
        removeWorktree(worktreeId);
      }
      console.log(
        `[slack] completed for ${userId}: turns=${result.numTurns} cost=$${result.costUsd.toFixed(3)} duration=${result.durationMs}ms`
      );
    })
    .catch(async (err) => {
      console.error(`[slack] agent error for ${userId}:`, err);
      if (!getSession(threadKey)) {
        removeWorktree(worktreeId);
      }
      if (slackStream) {
        await slackStream.stopStream();
        await slackStream.clearStatus();
      }
    });

  return c.json({ ok: true, message: "accepted" }, 202);
});

function buildSlackThreadUrl(channel: string, threadTs: string): string {
  return `https://comprehensiveio.slack.com/archives/${channel}/p${threadTs.replace(".", "")}`;
}

function buildSlackPrompt({
  message,
  channel,
  channelName,
  threadTs,
  userId,
}: {
  message: string;
  channel: string;
  channelName?: string;
  threadTs?: string;
  userId?: string;
}) {
  const lines = [
    `Slack message from user ${userId || "unknown"}.`,
    ``,
    `Reply to:`,
    `- channel: ${channel}`,
    channelName ? `- channel_name: ${channelName}` : ``,
    threadTs ? `- thread_ts: ${threadTs} (reply in this thread)` : `- no thread (start a new message)`,
    threadTs ? `- slack_thread_url: ${buildSlackThreadUrl(channel, threadTs)}` : ``,
    ``,
    message,
  ];
  return lines.join("\n");
}

function normalizeChannelName(channelName?: string): string | undefined {
  const normalized = channelName?.replace(/[\r\n]+/g, " ").trim();
  return normalized || undefined;
}
