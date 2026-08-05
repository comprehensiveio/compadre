import { Hono } from "hono";
import { DEFAULT_MAX_TURNS } from "../config.js";
import {
  configuredAgentProvider,
  runConversation,
} from "../conversation.js";
import { getSlackSystemPrompt, getSlackStreamingSystemPrompt } from "../prompts/index.js";
import { resolveSlackChannelName } from "../services/slack-context.js";
import { SlackStream } from "../services/slack-stream.js";
import { humanizeToolName } from "../services/tool-labels.js";
import { verifySlackSignature } from "../services/slack-verify.js";

export const slackEventsRoutes = new Hono();

const MAX_SEEN_EVENTS = 10_000;
const seenEvents = new Set<string>();

/** Deduplicate Slack events by `event.ts`. Returns true if already seen. */
function isDuplicate(ts: string): boolean {
  if (seenEvents.has(ts)) return true;
  seenEvents.add(ts);
  if (seenEvents.size > MAX_SEEN_EVENTS) {
    const iter = seenEvents.values();
    const oldest = iter.next().value;
    if (oldest !== undefined) seenEvents.delete(oldest);
  }
  return false;
}

const APP_LINK_REGEX = /https:\/\/(?:www\.)?app\.comprehensive\.io\/\S+/i;
const SLACKBOT_USER_ID = "U073509NYP7";
const PRODUCTION_SUPPORT_CHANNEL_ID = "C04D24LB4J1";

interface SlackEvent {
  type: string;
  subtype?: string;
  bot_id?: string;
  channel: string;
  user?: string;
  user_team?: string;
  team?: string;
  text: string;
  ts: string;
  thread_ts?: string;
}

slackEventsRoutes.post("/slack/events", async (c) => {
  const rawBody = await c.req.text();

  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    console.error("[slack-events] SLACK_SIGNING_SECRET not configured");
    return c.json({ error: "server misconfigured" }, 500);
  }

  const signature = c.req.header("X-Slack-Signature") || "";
  const timestamp = c.req.header("X-Slack-Request-Timestamp") || "";
  if (
    !verifySlackSignature({ signingSecret, signature, timestamp, body: rawBody })
  ) {
    return c.json({ error: "invalid signature" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }

  if (payload.type === "url_verification") {
    return c.json({ challenge: payload.challenge });
  }

  if (payload.type === "event_callback") {
    const event = payload.event;
    if (event && typeof event === "object") {
      const teamId =
        typeof payload.team_id === "string" ? payload.team_id : undefined;
      handleEvent(event as SlackEvent, teamId).catch((err) =>
        console.error("[slack-events] unhandled error in handleEvent:", err),
      );
    }
  }

  return c.json({ ok: true });
});

async function handleEvent(event: SlackEvent, teamId?: string) {
  if (event.type !== "message") return;
  if (event.subtype || event.bot_id) return;
  if (isDuplicate(event.ts)) return;

  const isDM = event.channel.startsWith("D");
  const isMention = event.text?.includes(`<@${SLACKBOT_USER_ID}>`);

  // Check for prod-support links before routing to AI, so @mentions in
  // #production-support that contain app links still get debug-link treatment.
  if (
    event.channel === PRODUCTION_SUPPORT_CHANNEL_ID &&
    APP_LINK_REGEX.test(event.text)
  ) {
    void forwardProdSupportLinks(event);
  }

  if (isDM || isMention) {
    handleAIMessage(event, isDM, teamId).catch((err) =>
      console.error("[slack-events] unhandled error in handleAIMessage:", err),
    );
  }
}

function buildSlackThreadUrl(channel: string, threadTs: string): string {
  return `https://comprehensiveio.slack.com/archives/${channel}/p${threadTs.replace(".", "")}`;
}

async function handleAIMessage(
  event: SlackEvent,
  isDM: boolean,
  teamId?: string,
) {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const threadTs = event.thread_ts || event.ts;

  const messageText = (event.text || "").replaceAll(`<@${SLACKBOT_USER_ID}>`, "").trim();

  const threadKey = threadTs;

  const [threadContext, channelName] = await Promise.all([
    event.thread_ts && botToken
      ? fetchThreadContext(
          event.channel,
          event.thread_ts,
          event.ts,
          botToken,
        )
      : null,
    botToken
      ? resolveSlackChannelName({
          channel: event.channel,
          userId: event.user,
          botToken,
        })
      : null,
  ]);

  const promptParts = ["User query:", messageText];
  if (threadContext) {
    promptParts.push(
      "",
      "Thread context (prior messages in this thread):",
      threadContext,
    );
  }
  const slackThreadUrl = buildSlackThreadUrl(event.channel, threadTs);
  promptParts.push(
    "",
    `Slack message from user ${event.user || "unknown"}.`,
    "",
    "Reply to:",
    `- channel: ${event.channel}`,
    ...(channelName ? [`- channel_name: ${channelName}`] : []),
    `- thread_ts: ${threadTs} (reply in this thread)`,
    `- slack_thread_url: ${slackThreadUrl}`,
  );
  const prompt = promptParts.join("\n");

  let slackStream: SlackStream | undefined;
  if (botToken) {
    slackStream = new SlackStream({
      channel: event.channel,
      threadTs,
      botToken,
      recipientUserId: event.user,
      recipientTeamId: event.user_team || event.team || teamId,
    });
  }

  // In non-DM contexts, use a reaction to indicate processing
  if (!isDM && slackStream) {
    await slackStream.addReaction("compadre-thinking", event.ts);
  }
  if (slackStream) {
    await slackStream.setStatus("is thinking...");
  }

  console.log(
    `[slack-events] routing user=${event.user ?? "unknown"} provider=${configuredAgentProvider()}`,
  );

  runConversation({
    prompt,
    threadId: threadKey,
    systemPrompt: (worktreePath) =>
      slackStream
        ? getSlackStreamingSystemPrompt(worktreePath)
        : getSlackSystemPrompt(worktreePath),
    maxTurns: DEFAULT_MAX_TURNS,
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
      if (!isDM && slackStream) {
        await slackStream.removeReaction("compadre-thinking", event.ts);
      }
      console.log(
        `[slack-events] completed for ${event.user}: provider=${result.provider} turns=${result.numTurns} cost=$${result.costUsd.toFixed(3)} duration=${result.durationMs}ms`,
      );
    })
    .catch(async (err) => {
      console.error(`[slack-events] agent error for ${event.user}:`, err);
      if (slackStream) {
        await slackStream.stopStream();
        await slackStream.clearStatus();
      }
      if (!isDM && slackStream) {
        await slackStream.removeReaction("compadre-thinking", event.ts);
        await slackStream.addReaction("compadre-failure", event.ts);
      } else if (isDM && botToken) {
        try {
          await fetch("https://slack.com/api/reactions.add", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${botToken}`,
            },
            body: JSON.stringify({
              channel: event.channel,
              timestamp: event.ts,
              name: "x",
            }),
          });
        } catch {
          /* ignore */
        }
      }
    });
}

async function fetchThreadContext(
  channel: string,
  threadTs: string,
  triggeringTs: string,
  botToken: string,
): Promise<string | null> {
  try {
    const res = await fetch(
      `https://slack.com/api/conversations.replies?${new URLSearchParams({
        channel,
        ts: threadTs,
        limit: "21",
      })}`,
      {
        headers: { Authorization: `Bearer ${botToken}` },
      },
    );
    const data = (await res.json()) as {
      ok: boolean;
      messages?: { user?: string; text?: string; ts: string }[];
      error?: string;
    };
    if (!data.ok || !data.messages) {
      console.error("[slack-events] conversations.replies failed:", data.error);
      return null;
    }
    const lines = data.messages
      .filter((m) => m.ts !== triggeringTs)
      .slice(-20)
      .map((m) => `<@${m.user || "unknown"}>: ${m.text || ""}`);
    return lines.length > 0 ? lines.join("\n") : null;
  } catch (err) {
    console.error("[slack-events] fetchThreadContext error:", err);
    return null;
  }
}

async function forwardProdSupportLinks(event: SlackEvent) {
  const compAppUrl = process.env.COMP_APP_URL;
  if (!compAppUrl) {
    console.error(
      "[slack-events] COMP_APP_URL not set, cannot forward prod-support links",
    );
    return;
  }

  const compadreApiKey = process.env.COMPADRE_API_KEY;
  if (!compadreApiKey) {
    console.error(
      "[slack-events] COMPADRE_API_KEY not set, cannot forward prod-support links",
    );
    return;
  }

  try {
    const res = await fetch(`${compAppUrl}/api/v1/slack/debug-links`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${compadreApiKey}`,
      },
      body: JSON.stringify({
        text: event.text,
        channel: event.channel,
        threadTs: event.thread_ts || event.ts,
      }),
    });
    if (!res.ok) {
      console.error(`[slack-events] debug-links returned ${res.status}`);
    }
  } catch (err) {
    console.error(
      "[slack-events] failed to forward prod-support links:",
      err,
    );
  }
}
