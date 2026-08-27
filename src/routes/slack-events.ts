import crypto from "node:crypto";
import { Hono } from "hono";
import {
  configuredAgentProvider,
  type ConversationOptions,
} from "../conversation.js";
import {
  getSlackSystemPrompt,
  getSlackStreamingSystemPrompt,
} from "../prompts/index.js";
import { resolveSlackChannelName } from "../services/slack-context.js";
import { parseAgentRouteDirective } from "../services/agent-routing.js";
import { buildSlackAgentInput } from "../services/slack-prompt.js";
import { SlackStream } from "../services/slack-stream.js";
import { configuredConversationRunner } from "../services/conversation-runner.js";
import { providerForAgentProfile } from "../tanstack/protocol.js";
import { humanizeToolName } from "../services/tool-labels.js";
import { slackFailureNotice } from "../services/terminal-response.js";
import { runSlackConversation } from "../services/slack-conversation.js";
import { SlackRunStateStore } from "../services/slack-run-state.js";
import { getRequiredThreadPersistence } from "../persistence/runtime.js";
import { HostedThreadBindingStore } from "../services/hosted-thread-bindings.js";
import { verifySlackSignature } from "../services/slack-verify.js";
import {
  canonicalSlackThreadId,
  nativeT3SlackEnabled,
  t3SlackDetailsMarkdown,
} from "../services/t3-slack-conversation.js";
import {
  configuredCentralT3Client,
  runCentralT3Conversation,
} from "../t3/central-conversation.js";
import {
  mergeSlackFileReferences,
  slackFileReferences,
  type SlackEventFile,
  type SlackFileReference,
} from "../services/slack-files.js";

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
const PRODUCTION_SUPPORT_CHANNEL_ID = "C04D24LB4J1";

interface SlackAuthorization {
  user_id?: string;
  is_bot?: boolean;
}

export interface SlackEvent {
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
  files?: SlackEventFile[];
}

/** Accept ordinary user messages, including messages with attached files. */
export function isSupportedUserMessage(event: SlackEvent): boolean {
  if (event.bot_id) return false;
  if (event.type === "app_mention") return event.subtype === undefined;
  if (event.type !== "message") return false;
  return event.subtype === undefined || event.subtype === "file_share";
}

/** Resolve this installation's bot identity without coupling ingress to one Slack app. */
export function resolveSlackBotUserId(input: {
  configured?: string;
  authorizations?: SlackAuthorization[];
  event?: SlackEvent;
}): string | undefined {
  const configured = input.configured?.trim();
  if (configured) return configured;
  const authorized = input.authorizations?.find(
    (authorization) => authorization.is_bot && authorization.user_id,
  )?.user_id;
  if (authorized) return authorized;
  if (input.event?.type === "app_mention") {
    return /<@([A-Z0-9]+)>/.exec(input.event.text || "")?.[1];
  }
  return undefined;
}

export function stripSlackBotMention(text: string, botUserId?: string): string {
  return botUserId
    ? text.replaceAll(`<@${botUserId}>`, "").trim()
    : text.trim();
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
    !verifySlackSignature({
      signingSecret,
      signature,
      timestamp,
      body: rawBody,
    })
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
      const botUserId = resolveSlackBotUserId({
        configured: process.env.SLACK_BOT_USER_ID,
        authorizations: Array.isArray(payload.authorizations)
          ? (payload.authorizations as SlackAuthorization[])
          : undefined,
        event: event as SlackEvent,
      });
      handleEvent(event as SlackEvent, teamId, botUserId).catch((err) =>
        console.error("[slack-events] unhandled error in handleEvent:", err),
      );
    }
  }

  return c.json({ ok: true });
});

async function handleEvent(
  event: SlackEvent,
  teamId?: string,
  botUserId?: string,
) {
  if (!isSupportedUserMessage(event)) return;
  if (isDuplicate(event.ts)) return;

  const isDM = event.channel.startsWith("D");
  const isMention =
    event.type === "app_mention" ||
    Boolean(botUserId && event.text?.includes(`<@${botUserId}>`));

  // Check for prod-support links before routing to AI, so @mentions in
  // #production-support that contain app links still get debug-link treatment.
  if (
    event.channel === PRODUCTION_SUPPORT_CHANNEL_ID &&
    APP_LINK_REGEX.test(event.text)
  ) {
    void forwardProdSupportLinks(event);
  }

  if (isDM || isMention) {
    handleAIMessage(event, isDM, teamId, botUserId).catch((err) =>
      console.error("[slack-events] unhandled error in handleAIMessage:", err),
    );
  }
}

async function handleAIMessage(
  event: SlackEvent,
  isDM: boolean,
  teamId?: string,
  botUserId?: string,
) {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const threadTs = event.thread_ts || event.ts;

  const rawMessageText = stripSlackBotMention(event.text || "", botUserId);
  const route = parseAgentRouteDirective(rawMessageText);
  if (!route.ok) {
    const errorStream = createSlackStream(event, threadTs, botToken, teamId);
    if (errorStream) {
      errorStream.appendText(route.error);
      await errorStream.stopStream();
    } else {
      console.warn(`[slack-events] ${route.error}`);
    }
    return;
  }

  const { messageText, profile } = route;

  const threadKey = threadTs;

  const [thread, channelName] = await Promise.all([
    event.thread_ts && botToken
      ? fetchThreadContext(event.channel, event.thread_ts, event.ts, botToken)
      : null,
    botToken
      ? resolveSlackChannelName({
          channel: event.channel,
          userId: event.user,
          botToken,
        })
      : null,
  ]);
  const threadContext = thread?.text ?? null;
  const slackFiles = mergeSlackFileReferences(
    slackFileReferences(event.files),
    thread?.files,
  );

  const { prompt, transcriptUserMessage } = buildSlackAgentInput({
    messageText,
    threadContext,
    channel: event.channel,
    channelName,
    threadTs,
    userId: event.user,
  });

  const slackStream = createSlackStream(event, threadTs, botToken, teamId);

  const runId = crypto.randomUUID();
  const runtime = await getRequiredThreadPersistence();
  const slackRuns = new SlackRunStateStore(
    runtime.persistence.stores.metadata,
    runtime.persistence.stores.runs,
  );
  const hostedBindings = new HostedThreadBindingStore(
    runtime.persistence.stores.metadata,
  );
  const slackBinding = {
    channelId: event.channel,
    threadTs,
    ...(event.user ? { recipientUserId: event.user } : {}),
    ...((event.user_team || event.team || teamId)
      ? { recipientTeamId: event.user_team || event.team || teamId }
      : {}),
  };

  // In non-DM contexts, use a reaction to indicate processing
  if (!isDM && slackStream) {
    await slackStream.markRunStarted(event.ts);
  }
  if (slackStream) {
    await slackStream.setStatus("is thinking...");
  }

  console.log(
    `[slack-events] routing user=${event.user ?? "unknown"} provider=${profile ? providerForAgentProfile(profile) : configuredAgentProvider()} profile=${profile ?? "default"}`,
  );

  if (nativeT3SlackEnabled()) {
    const canonicalThreadId = canonicalSlackThreadId({
      teamId: event.user_team || event.team || teamId,
      channel: event.channel,
      threadTs,
    });
    const nativeConversation = Promise.resolve().then(async () => {
      const client = configuredCentralT3Client();
      if (!client) {
        throw new Error(
          "Native T3 Slack requires COMPADRE_T3_CENTRAL_URL and COMPADRE_T3_CENTRAL_TOKEN.",
        );
      }
      return runCentralT3Conversation({
        client,
        canonicalThreadId,
        title: transcriptUserMessage.slice(0, 200) || "Slack request",
        prompt,
        displayText: transcriptUserMessage,
        profile,
        async onPrepared(prepared) {
          await hostedBindings.bindAlias(canonicalThreadId, prepared.t3ThreadId);
          await hostedBindings.bindSlack(prepared.t3ThreadId, {
            ...slackBinding,
            t3EnvironmentId: prepared.environmentId,
            t3ThreadId: prepared.t3ThreadId,
          });
        },
        onTextDelta: slackStream
          ? (text) => {
              slackStream.appendText(text);
            }
          : undefined,
        onToolStart: slackStream
          ? (name) => slackStream.setStatus(
              `is ${humanizeToolName(name).toLowerCase()}...`,
            )
          : undefined,
      });
    });

    nativeConversation
      .then(async (result) => {
        if (slackStream) {
          slackStream.appendText(`\n\n${t3SlackDetailsMarkdown(result.detailsUrl)}`);
          await slackStream.stopStream();
          await slackStream.clearStatus();
        }
        if (!isDM && slackStream) {
          await slackStream.markRunSucceeded(event.ts);
        }
        await slackRuns.forget(event.channel, event.ts);
        console.log(
          `[slack-events] central T3 completed user=${event.user ?? "unknown"} thread=${result.t3ThreadId} provider=${result.modelSelection.instanceId} model=${result.modelSelection.model} resumed=${result.resumed}`,
        );
      })
      .catch(async (err) => {
        console.error(`[slack-events] native T3 error for ${event.user}:`, err);
        if (slackStream) {
          await slackStream.stopStream();
          await slackStream.clearStatus();
          await slackStream.postThreadMessage(slackFailureNotice(err));
        }
        if (!isDM && slackStream) {
          await slackStream.markRunFailed(event.ts);
        }
      });
    return;
  }

  await hostedBindings.bindSlack(threadKey, slackBinding);

  const runner = configuredConversationRunner();
  const conversationOptions: Omit<ConversationOptions, "stream"> = {
    runId,
    prompt,
    transcriptUserMessage,
    threadId: threadKey,
    profile,
    slackFiles,
    systemPrompt: undefined,
  };
  const conversation = slackStream
    ? runSlackConversation({
        runner,
        options: conversationOptions,
        delivery: {
          appendText: (text) => slackStream.appendText(text),
          hasTruncatedContent: () => slackStream.hasTruncatedContent(),
          onToolStart: (name) => {
            void slackStream.setStatus(
              `is ${humanizeToolName(name).toLowerCase()}...`,
            );
          },
          async onAutoContinue() {
            slackStream.appendText("\n\n");
            await slackStream.setStatus("is continuing automatically...");
          },
          onRunStart: (nextRunId) =>
            slackRuns.record(event.channel, event.ts, nextRunId),
        },
      })
    : runner(conversationOptions).then((result) => ({
        result,
        autoContinued: false,
      }));

  conversation
    .then(async ({ result, autoContinued }) => {
      if (slackStream) {
        await slackStream.stopStream();
        await slackStream.clearStatus();
      }
      if (!isDM && slackStream) {
        await slackStream.markRunSucceeded(event.ts);
      }
      await slackRuns.forget(event.channel, event.ts);
      console.log(
        `[slack-events] completed for ${event.user}: provider=${result.provider} turns=${result.numTurns} cost=$${result.costUsd.toFixed(3)} duration=${result.durationMs}ms autoContinued=${autoContinued}`,
      );
    })
    .catch(async (err) => {
      console.error(`[slack-events] agent error for ${event.user}:`, err);
      if (slackStream) {
        await slackStream.stopStream();
        await slackStream.clearStatus();
        await slackStream.postThreadMessage(slackFailureNotice(err));
      }
      if (!isDM && slackStream) {
        await slackStream.markRunFailed(event.ts);
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

function createSlackStream(
  event: SlackEvent,
  threadTs: string,
  botToken: string | undefined,
  teamId: string | undefined,
): SlackStream | undefined {
  return botToken
    ? new SlackStream({
        channel: event.channel,
        threadTs,
        botToken,
        recipientUserId: event.user,
        recipientTeamId: event.user_team || event.team || teamId,
      })
    : undefined;
}

async function fetchThreadContext(
  channel: string,
  threadTs: string,
  triggeringTs: string,
  botToken: string,
): Promise<{ text: string | null; files: SlackFileReference[] }> {
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
      messages?: {
        user?: string;
        text?: string;
        ts: string;
        files?: SlackEventFile[];
      }[];
      error?: string;
    };
    if (!data.ok || !data.messages) {
      console.error("[slack-events] conversations.replies failed:", data.error);
      return { text: null, files: [] };
    }
    const messages = data.messages
      .filter((message) => message.ts !== triggeringTs)
      .slice(-20);
    const lines = messages.map(
      (message) => `<@${message.user || "unknown"}>: ${message.text || ""}`,
    );
    return {
      text: lines.length > 0 ? lines.join("\n") : null,
      files: mergeSlackFileReferences(
        ...messages.map((message) => slackFileReferences(message.files)),
      ),
    };
  } catch (err) {
    console.error("[slack-events] fetchThreadContext error:", err);
    return { text: null, files: [] };
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

  const compadreApiKey =
    process.env.COMP_APP_API_KEY ?? process.env.COMPADRE_API_KEY;
  if (!compadreApiKey) {
    console.error(
      "[slack-events] COMP_APP_API_KEY/COMPADRE_API_KEY not set, cannot forward prod-support links",
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
    console.error("[slack-events] failed to forward prod-support links:", err);
  }
}
