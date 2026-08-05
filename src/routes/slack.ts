import { Hono } from "hono";
import { DEFAULT_MAX_TURNS } from "../config.js";
import { runConversation } from "../conversation.js";
import { getSlackSystemPrompt, getSlackStreamingSystemPrompt } from "../prompts/index.js";
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
  const teamId = body.teamId as string | undefined;
  const sentChannelName =
    typeof body.channelName === "string" ? body.channelName : undefined;

  if (!channel) {
    return c.json({ error: "missing 'channel' field" }, 400);
  }

  const threadKey = threadTs || `${channel}-${Date.now()}`;

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
    slackStream = new SlackStream({
      channel,
      threadTs,
      botToken,
      recipientUserId: userId,
      recipientTeamId: teamId,
    });
    void slackStream.setStatus("is thinking...");
  }

  // Fire and forget — respond 202 immediately
  runConversation({
    prompt,
    threadId: threadKey,
    systemPrompt: (worktreePath) =>
      slackStream
        ? getSlackStreamingSystemPrompt(worktreePath)
        : getSlackSystemPrompt(worktreePath),
    maxTurns: (body.maxTurns as number) ?? DEFAULT_MAX_TURNS,
    stream: slackStream
      ? {
          onTextDelta: (text) => void slackStream!.appendText(text),
          onToolStart: (name) =>
            void slackStream!.setStatus(
              `is ${humanizeToolName(name).toLowerCase()}...`,
            ),
          onComplete: async () => {
            await slackStream!.stopStream();
            await slackStream!.clearStatus();
          },
        }
      : undefined,
  })
    .then(async (result) => {
      console.log(
        `[slack] completed for ${userId}: provider=${result.provider} turns=${result.numTurns} cost=$${result.costUsd.toFixed(3)} duration=${result.durationMs}ms`
      );
    })
    .catch(async (err) => {
      console.error(`[slack] agent error for ${userId}:`, err);
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
