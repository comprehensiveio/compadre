import crypto from "crypto";
import { Hono } from "hono";
import { runTask } from "../agent.js";
import { DEFAULT_MAX_TURNS, DEFAULT_MAX_BUDGET_USD } from "../config.js";
import { getSlackSystemPrompt, getSlackStreamingSystemPrompt } from "../prompts/index.js";
import { createWorktree, removeWorktree } from "../repo.js";
import { getSession, setSession } from "../sessions.js";
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
    handleAIMessage(event, isDM).catch((err) =>
      console.error("[slack-events] unhandled error in handleAIMessage:", err),
    );
  }
}

function buildSlackThreadUrl(channel: string, threadTs: string): string {
  return `https://comprehensiveio.slack.com/archives/${channel}/p${threadTs.replace(".", "")}`;
}

async function handleAIMessage(event: SlackEvent, isDM: boolean) {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const threadTs = event.thread_ts || event.ts;

  const messageText = (event.text || "").replaceAll(`<@${SLACKBOT_USER_ID}>`, "").trim();

  const threadKey = threadTs;
  const existing = getSession(threadKey);
  const sessionId = existing?.sessionId;
  const worktreeId = existing?.worktreeId ?? crypto.randomUUID();
  const worktreePath = createWorktree(worktreeId);

  // Fetch thread context when mentioned in an existing thread
  let threadContext: string | null = null;
  if (event.thread_ts && botToken) {
    threadContext = await fetchThreadContext(
      event.channel,
      event.thread_ts,
      event.ts,
      botToken,
    );
  }

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
      enableStatus: isDM,
    });
  }

  // In non-DM contexts, use a reaction to indicate processing
  if (!isDM && slackStream) {
    await slackStream.addReaction("compadre-thinking", event.ts);
  }

  runTask({
    prompt,
    sessionId,
    systemPrompt: slackStream ? getSlackStreamingSystemPrompt(worktreePath) : getSlackSystemPrompt(worktreePath),
    worktreePath,
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
    .then(async (result) => {
      if (result.sessionId) {
        setSession(threadKey, { sessionId: result.sessionId, worktreeId });
      } else {
        // Only remove the worktree when there's no session to resume.
        // Multi-turn conversations need the worktree preserved between turns
        // so that commits and branches created in earlier turns persist.
        removeWorktree(worktreeId);
      }
      if (!isDM && slackStream) {
        await slackStream.removeReaction("compadre-thinking", event.ts);
      }
      console.log(
        `[slack-events] completed for ${event.user}: turns=${result.numTurns} cost=$${result.costUsd.toFixed(3)} duration=${result.durationMs}ms`,
      );
    })
    .catch(async (err) => {
      console.error(`[slack-events] agent error for ${event.user}:`, err);
      if (!getSession(threadKey)) {
        removeWorktree(worktreeId);
      }
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
