import { Hono } from "hono";
import { runTask } from "../agent.js";
import { DEFAULT_MAX_TURNS, DEFAULT_MAX_BUDGET_USD } from "../config.js";
import { getSlackSystemPrompt, getSlackStreamingSystemPrompt } from "../prompts/index.js";
import { SlackStream, humanizeToolName } from "../services/slack-stream.js";
import { verifySlackSignature } from "../services/slack-verify.js";

export const slackEventsRoutes = new Hono();

const MAX_THREAD_SESSIONS = 5000;
const threadSessions = new Map<string, string>();

/** Evict oldest entries when the map exceeds the cap. */
function pruneThreadSessions() {
  if (threadSessions.size <= MAX_THREAD_SESSIONS) return;
  const toDelete = threadSessions.size - MAX_THREAD_SESSIONS;
  const iter = threadSessions.keys();
  for (let i = 0; i < toDelete; i++) {
    const key = iter.next().value;
    if (key !== undefined) threadSessions.delete(key);
  }
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
      handleEvent(event as SlackEvent).catch((err) =>
        console.error("[slack-events] unhandled error in handleEvent:", err),
      );
    }
  }

  return c.json({ ok: true });
});

async function handleEvent(event: SlackEvent) {
  if (event.type !== "message") return;
  if (event.subtype || event.bot_id) return;

  const isDM = event.channel.startsWith("D");
  const isMention = event.text?.startsWith(`<@${SLACKBOT_USER_ID}>`);

  // Check for prod-support links before routing to AI, so @mentions in
  // #production-support that contain app links still get debug-link treatment.
  if (
    event.channel === PRODUCTION_SUPPORT_CHANNEL_ID &&
    APP_LINK_REGEX.test(event.text)
  ) {
    void forwardProdSupportLinks(event);
  }

  if (isDM || isMention) {
    handleAIMessage(event);
  }
}

function handleAIMessage(event: SlackEvent) {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const threadTs = event.thread_ts || event.ts;

  let messageText = event.text;
  if (messageText.startsWith(`<@${SLACKBOT_USER_ID}>`)) {
    messageText = messageText.slice(`<@${SLACKBOT_USER_ID}>`.length).trim();
  }

  const threadKey = threadTs;
  const sessionId = threadSessions.get(threadKey);

  const prompt = [
    `Slack message from user ${event.user || "unknown"}.`,
    "",
    "Reply to:",
    `- channel: ${event.channel}`,
    `- thread_ts: ${threadTs} (reply in this thread)`,
    "",
    messageText,
  ].join("\n");

  let slackStream: SlackStream | undefined;
  if (botToken) {
    slackStream = new SlackStream({
      channel: event.channel,
      threadTs,
      botToken,
    });
  }

  runTask({
    prompt,
    sessionId,
    systemPrompt: slackStream ? getSlackStreamingSystemPrompt() : getSlackSystemPrompt(),
    maxTurns: DEFAULT_MAX_TURNS,
    maxBudgetUsd: DEFAULT_MAX_BUDGET_USD,
    stream: slackStream
      ? {
          onTextDelta: (text) => void slackStream!.appendText(text),
          onToolStart: (name) =>
            void slackStream!.setStatus(humanizeToolName(name) + "..."),
          onComplete: () => {
            void slackStream!.stopStream();
            void slackStream!.clearStatus();
          },
        }
      : undefined,
  })
    .then((result) => {
      if (result.sessionId) {
        threadSessions.set(threadKey, result.sessionId);
        pruneThreadSessions();
      }
      console.log(
        `[slack-events] completed for ${event.user}: turns=${result.numTurns} cost=$${result.costUsd.toFixed(3)} duration=${result.durationMs}ms`,
      );
    })
    .catch(async (err) => {
      console.error(`[slack-events] agent error for ${event.user}:`, err);
      if (slackStream) {
        await slackStream.stopStream();
        await slackStream.clearStatus();
      }
      if (botToken) {
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
