import crypto from "node:crypto";
import { Hono } from "hono";
import { log, serializeError } from "../logging.js";
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
import {
  buildSlackAgentInput,
  buildSlackThreadUrl,
  slackThreadContextPrompt,
} from "../services/slack-prompt.js";
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
  t3ModelSelectionForProfile,
  t3SlackSessionLink,
} from "../services/t3-slack-conversation.js";
import {
  centralT3ThreadId,
  configuredCentralT3Client,
  runCentralT3Conversation,
} from "../t3/central-conversation.js";
import type { T3Client } from "../t3/client.js";
import {
  downloadSlackInputFiles,
  mergeSlackFileReferences,
  slackFileReferences,
  type SlackEventFile,
  type SlackFileReference,
} from "../services/slack-files.js";
import { getConfiguredUserDirectory } from "../services/user-directory-runtime.js";
import {
  resolveSlackMessageAttribution,
  resolveSlackThreadParticipants,
} from "../services/slack-user-attribution.js";
import {
  SlackTurnDeliveryStore,
  type SlackTurnDelivery,
} from "../services/slack-turn-delivery-store.js";
import { deliverClaimedSlackTurn } from "../services/slack-turn-delivery.js";
import { isAllowedSlackApp } from "../services/slack-installation.js";
import {
  getConfiguredSlackInbox,
  type SlackInboxRouteHooks,
} from "../services/slack-inbox.js";

export const slackEventsRoutes = new Hono();

const MAX_SEEN_EVENTS = 10_000;
const SLACK_DELIVERY_RESERVATION_HEARTBEAT_MS = 60_000;
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

export interface AgentSessionStoppedEvent {
  type: "agent_session_stopped";
  channel: string;
  user: string;
  event_ts: string;
  thread_ts: string;
  streaming_message_ts: string[];
}

export function isAgentSessionStoppedEvent(
  event: unknown,
): event is AgentSessionStoppedEvent {
  if (typeof event !== "object" || event === null) return false;
  const record = event as Record<string, unknown>;
  return (
    record.type === "agent_session_stopped" &&
    typeof record.channel === "string" &&
    typeof record.user === "string" &&
    typeof record.event_ts === "string" &&
    typeof record.thread_ts === "string" &&
    Array.isArray(record.streaming_message_ts) &&
    record.streaming_message_ts.every((value) => typeof value === "string")
  );
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

export const MENTION_ONLY_THREAD_PROMPT =
  "Respond to the preceding Slack message.";

export function slackMessageTextForAgent(input: {
  messageText: string;
  isThreadReply: boolean;
  mentionsBot: boolean;
}): string {
  if (input.messageText.trim()) return input.messageText.trim();
  return input.isThreadReply && input.mentionsBot
    ? MENTION_ONLY_THREAD_PROMPT
    : "";
}

export function isAllowedSlackWorkspace(input: {
  configuredWorkspaceId?: string;
  eventWorkspaceId?: string;
}): boolean {
  const configuredWorkspaceId = input.configuredWorkspaceId?.trim();
  return Boolean(
    configuredWorkspaceId &&
      input.eventWorkspaceId &&
      input.eventWorkspaceId === configuredWorkspaceId,
  );
}

/** Interrupt the exact central T3 turn represented by Slack's native Stop. */
export async function stopHostedSlackSession(
  event: Pick<
    AgentSessionStoppedEvent,
    "channel" | "thread_ts" | "event_ts"
  >,
  workspaceId: string,
  dependencies: {
    configuredWorkspaceId: string;
    bindings: Pick<HostedThreadBindingStore, "slack">;
    centralClient: Pick<T3Client, "snapshot" | "interruptTurn">;
  },
): Promise<boolean> {
  if (workspaceId !== dependencies.configuredWorkspaceId) return false;
  const canonicalThreadId = canonicalSlackThreadId({
    teamId: workspaceId,
    channel: event.channel,
    threadTs: event.thread_ts,
  });
  const threadId = centralT3ThreadId(canonicalThreadId);
  const binding = await dependencies.bindings.slack(threadId);
  if (
    !binding ||
    binding.channelId !== event.channel ||
    binding.threadTs !== event.thread_ts
  ) {
    return false;
  }

  const snapshot = await dependencies.centralClient.snapshot();
  const turn = snapshot.threads.find((thread) => thread.id === threadId)
    ?.latestTurn;
  const eventTime = Number(event.event_ts);
  // Slack can redeliver stop events. Never let an older event cancel a newer
  // turn that began after the user pressed Stop.
  if (
    !turn ||
    turn.state !== "running" ||
    !Number.isFinite(eventTime) ||
    Date.parse(turn.requestedAt) > eventTime * 1_000
  ) {
    return false;
  }

  await dependencies.centralClient.interruptTurn({
    threadId,
    turnId: turn.turnId,
    commandId: centralT3ThreadId(
      `slack-stop:${workspaceId}:${event.channel}:${event.event_ts}`,
    ),
  });
  return true;
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
    const teamId =
      typeof payload.team_id === "string" ? payload.team_id : undefined;
    const configuredWorkspaceId = process.env.COMPADRE_SLACK_WORKSPACE_ID;
    const eventAppId =
      typeof payload.api_app_id === "string" ? payload.api_app_id : undefined;
    if (
      !isAllowedSlackApp({
        configuredAppId: process.env.COMPADRE_SLACK_APP_ID,
        eventAppId,
      })
    ) {
      console.warn("[slack-events] rejected event from unauthorized app", {
        eventAppId,
      });
      return c.json({ error: "app not allowed" }, 403);
    }
    if (!configuredWorkspaceId?.trim()) {
      console.error(
        "[slack-events] COMPADRE_SLACK_WORKSPACE_ID not configured",
      );
      return c.json({ error: "server misconfigured" }, 500);
    }
    if (
      !isAllowedSlackWorkspace({
        configuredWorkspaceId,
        eventWorkspaceId: teamId,
      })
    ) {
      console.warn("[slack-events] rejected event from unauthorized workspace", {
        teamId,
      });
      return c.json({ error: "workspace not allowed" }, 403);
    }

    const event = payload.event;
    if (event && typeof event === "object") {
      if (isAgentSessionStoppedEvent(event)) {
        let interrupted = false;
        if (nativeT3SlackEnabled()) {
          try {
            const client = configuredCentralT3Client();
            if (!client) {
              throw new Error(
                "Slack Stop requires COMPADRE_T3_CENTRAL_URL and COMPADRE_T3_CENTRAL_TOKEN.",
              );
            }
            const runtime = await getRequiredThreadPersistence();
            interrupted = await stopHostedSlackSession(event, teamId ?? "", {
              configuredWorkspaceId,
              bindings: new HostedThreadBindingStore(
                runtime.persistence.stores.metadata,
              ),
              centralClient: client,
            });
          } catch (error) {
            log.error(
              {
                slackChannelId: event.channel,
                slackThreadTs: event.thread_ts,
                ...serializeError(error),
              },
              "slack agent session stop request failed",
            );
          }
        }
        log.info(
          {
            slackChannelId: event.channel,
            slackThreadTs: event.thread_ts,
            slackUserId: event.user,
            interrupted,
          },
          "slack agent session stop request acknowledged",
        );
        return c.json({ ok: true });
      }
      const botUserId = resolveSlackBotUserId({
        configured: process.env.SLACK_BOT_USER_ID,
        authorizations: Array.isArray(payload.authorizations)
          ? (payload.authorizations as SlackAuthorization[])
          : undefined,
        event: event as SlackEvent,
      });
      const slackEvent = event as SlackEvent;
      const inbox = getConfiguredSlackInbox();
      if (inbox && isAiRoutableSlackEvent(slackEvent, botUserId)) {
        // Persist BEFORE acknowledging: after the 200, Slack never retries,
        // so the row is the only thing standing between a deploy and a lost
        // message. The key spans app_mention/message duplicates of the same
        // message and Slack's own delivery retries.
        try {
          await inbox.store.enqueue({
            eventKey: durableSlackEventKey(slackEvent, teamId),
            ...(teamId ? { teamId } : {}),
            ...(botUserId ? { botUserId } : {}),
            event: slackEvent,
          });
        } catch (error) {
          log.error(
            {
              slackChannelId: slackEvent.channel,
              slackTs: slackEvent.ts,
              ...serializeError(error),
            },
            "slack durable ingress persistence failed",
          );
          // Fail the delivery so Slack retries it.
          return c.json({ error: "ingress persistence failed" }, 500);
        }
        inbox.poke();
      } else {
        handleEvent(slackEvent, teamId, botUserId).catch((err) =>
          log.error(
            {
              slackChannelId: slackEvent.channel,
              slackTs: slackEvent.ts,
              slackUserId: slackEvent.user,
              ...serializeError(err),
            },
            "slack handleEvent unhandled error",
          ),
        );
      }
    }
  }

  return c.json({ ok: true });
});

/** One message may arrive as both app_mention and message.channels. */
export function durableSlackEventKey(
  event: SlackEvent,
  teamId?: string,
): string {
  return `${teamId ?? event.team ?? "unknown"}:${event.channel}:${event.ts}`;
}

/** The subset of events the AI conversation path would act on. */
export function isAiRoutableSlackEvent(
  event: SlackEvent,
  botUserId?: string,
): boolean {
  if (!isSupportedUserMessage(event)) return false;
  const isDM = event.channel.startsWith("D");
  const isMention =
    event.type === "app_mention" ||
    Boolean(botUserId && event.text?.includes(`<@${botUserId}>`));
  return isDM || isMention;
}

async function handleEvent(
  event: SlackEvent,
  teamId?: string,
  botUserId?: string,
) {
  if (!isSupportedUserMessage(event)) return;
  if (isDuplicate(event.ts)) return;
  await routeSlackEvent(event, teamId, botUserId);
}

/**
 * Route one verified Slack event. Used directly for non-durable events and
 * by the inbox processor for persisted ones; dedupe belongs to the caller
 * (the in-memory set for direct events, the inbox primary key for durable
 * ones) so a retried durable event is never dropped as "seen".
 */
export async function routeSlackEvent(
  event: SlackEvent,
  teamId?: string,
  botUserId?: string,
  hooks?: SlackInboxRouteHooks,
) {
  if (!isSupportedUserMessage(event)) return;

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
    await handleAIMessage(event, isDM, teamId, botUserId, hooks).catch((err) =>
      log.error(
        {
          slackChannelId: event.channel,
          slackTs: event.ts,
          slackUserId: event.user,
          ...serializeError(err),
        },
        "slack handleAIMessage unhandled error",
      ),
    );
  }
}

async function handleAIMessage(
  event: SlackEvent,
  isDM: boolean,
  teamId?: string,
  botUserId?: string,
  hooks?: SlackInboxRouteHooks,
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

  const { messageText: routedMessageText, profile } = route;
  const mentionsBot =
    event.type === "app_mention" ||
    Boolean(botUserId && event.text?.includes(`<@${botUserId}>`));
  const isThreadReply = Boolean(event.thread_ts && event.thread_ts !== event.ts);
  const isMentionOnlyThreadReply =
    isThreadReply && !routedMessageText.trim() && mentionsBot;
  const messageText = slackMessageTextForAgent({
    messageText: routedMessageText,
    isThreadReply,
    mentionsBot,
  });
  if (!messageText) return;

  const threadKey = threadTs;
  const workspaceId = event.user_team || event.team || teamId;

  const [thread, channelName, directory] = await Promise.all([
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
    getConfiguredUserDirectory().catch((error) => {
      log.warn(serializeError(error), "slack user directory unavailable");
      return null;
    }),
  ]);
  const slackParticipantIds = [
    event.user,
    ...(thread?.participantUserIds ?? []),
  ].filter(
    (userId): userId is string => Boolean(userId) && userId !== botUserId,
  );
  const participants = await resolveSlackThreadParticipants({
    directory,
    botToken,
    workspaceId,
    slackUserIds: slackParticipantIds,
  }).catch((error) => {
    console.warn("[slack-events] could not persist Slack thread participants", {
      workspaceId,
      channelId: event.channel,
      threadTs,
      error,
    });
    return [];
  });
  const attribution = await resolveSlackMessageAttribution({
    directory,
    botToken,
    workspaceId,
    slackUserId: event.user,
    channelId: event.channel,
    messageTs: event.ts,
    threadTs,
    threadUrl: buildSlackThreadUrl(event.channel, threadTs),
    ...(participants.length > 0 ? { participants } : {}),
  }).catch((error) => {
    console.warn("[slack-events] could not persist Slack user attribution", {
      workspaceId,
      slackUserId: event.user,
      error,
    });
    return undefined;
  });
  const threadContext = thread?.text ?? null;
  const currentSlackFiles = slackFileReferences(event.files);
  const slackFiles = mergeSlackFileReferences(
    currentSlackFiles,
    thread?.files,
  );
  const nativeSlackInputFiles = nativeT3SlackEnabled()
    ? await downloadSlackInputFiles(currentSlackFiles)
    : { files: [], warnings: [] };
  let contextualSlackInputFiles: ReturnType<typeof downloadSlackInputFiles> | undefined;
  const loadContextualSlackInputFiles = async () => {
    contextualSlackInputFiles ??= downloadSlackInputFiles(slackFiles);
    return (await contextualSlackInputFiles).files;
  };

  const useNativeT3 = nativeT3SlackEnabled();
  const { prompt, transcriptUserMessage } = buildSlackAgentInput({
    messageText,
    threadContext: useNativeT3 ? null : threadContext,
    channel: event.channel,
    channelName,
    threadTs,
    userId: event.user,
  });
  const nativePrompt = nativeSlackInputFiles.warnings.length > 0
    ? `${prompt}\n\nSlack attachment warnings:\n${nativeSlackInputFiles.warnings.map((warning) => `- ${warning}`).join("\n")}`
    : prompt;

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
  const slackDeliveries = runtime.database
    ? new SlackTurnDeliveryStore(runtime.database)
    : null;
  const slackBinding = {
    channelId: event.channel,
    threadTs,
    ...(event.user ? { recipientUserId: event.user } : {}),
    ...(event.user_team || event.team || teamId
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

  const routedProvider = useNativeT3
    ? t3ModelSelectionForProfile(profile).instanceId
    : profile
      ? providerForAgentProfile(profile)
      : configuredAgentProvider();
  console.log(
    `[slack-events] routing user=${event.user ?? "unknown"} provider=${routedProvider} profile=${profile ?? "default"}`,
  );

  if (useNativeT3) {
    const canonicalThreadId = canonicalSlackThreadId({
      teamId: event.user_team || event.team || teamId,
      channel: event.channel,
      threadTs,
    });
    let centralClient: ReturnType<typeof configuredCentralT3Client> = null;
    let dispatchedMessageId: string | undefined;
    let reservedSlackDelivery: SlackTurnDelivery | null = null;
    let reservationHeartbeat: ReturnType<typeof setInterval> | undefined;
    const stopReservationHeartbeat = () => {
      if (!reservationHeartbeat) return;
      clearInterval(reservationHeartbeat);
      reservationHeartbeat = undefined;
    };
    const nativeConversation = Promise.resolve().then(async () => {
      const client = configuredCentralT3Client();
      if (!client) {
        throw new Error(
          "Native T3 Slack requires COMPADRE_T3_CENTRAL_URL and COMPADRE_T3_CENTRAL_TOKEN.",
        );
      }
      centralClient = client;
      return runCentralT3Conversation({
        client,
        canonicalThreadId,
        title: transcriptUserMessage.slice(0, 200) || "Slack request",
        prompt: nativePrompt,
        displayText: transcriptUserMessage,
        attribution,
        inputFiles: nativeSlackInputFiles.files,
        profile,
        returnAfterSteer: true,
        ...(isThreadReply
          ? isMentionOnlyThreadReply
            ? {
                loadTurnContext: async () =>
                  slackThreadContextPrompt(threadContext),
                loadTurnInputFiles: loadContextualSlackInputFiles,
              }
            : {
                loadInitialContext: async () =>
                  slackThreadContextPrompt(threadContext),
                loadInitialInputFiles: loadContextualSlackInputFiles,
              }
          : {}),
        async onPrepared(prepared) {
          await hostedBindings.bindAlias(
            canonicalThreadId,
            prepared.t3ThreadId,
          );
          await hostedBindings.bindSlack(prepared.t3ThreadId, {
            ...slackBinding,
            t3EnvironmentId: prepared.environmentId,
            t3ThreadId: prepared.t3ThreadId,
          });
        },
        async onDispatched(prepared, dispatch) {
          dispatchedMessageId = dispatch.messageId;
          // The turn is committed centrally; from here the outbox and the
          // run orchestrator own recovery, so the durable inbox row (when
          // this event came through it) must not be retried.
          if (hooks) {
            await Promise.resolve(hooks.onDurablyDispatched()).catch(
              (error) =>
                console.error(
                  "[slack-events] could not settle durable ingress row",
                  { channel: event.channel, ts: event.ts, error },
                ),
            );
          }
          if (prepared.steered) return;
          if (!slackDeliveries || !slackStream) return;
          const slackTeamId = workspaceId?.trim();
          if (!slackTeamId) {
            throw new Error(
              "Cannot enqueue Slack completion without a workspace id.",
            );
          }
          reservedSlackDelivery = await slackDeliveries.enqueueClaimed({
            id: crypto.randomUUID(),
            canonicalThreadId,
            t3ThreadId: prepared.t3ThreadId,
            environmentId: prepared.environmentId,
            dispatch,
            slackTeamId,
            slackChannelId: event.channel,
            slackThreadTs: threadTs,
            triggerMessageTs: event.ts,
            ...(event.user ? { recipientUserId: event.user } : {}),
            detailsUrl: prepared.detailsUrl,
          });
          if (reservedSlackDelivery) {
            reservationHeartbeat = setInterval(() => {
              void slackDeliveries
                .renewClaim(reservedSlackDelivery!)
                .catch((error) =>
                  console.warn(
                    "[slack-delivery] failed to renew foreground reservation",
                    { deliveryId: reservedSlackDelivery!.id, error },
                  ),
                );
            }, SLACK_DELIVERY_RESERVATION_HEARTBEAT_MS);
            reservationHeartbeat.unref();
          }
        },
        onToolStart: slackStream
          ? async (name) => {
              const status = `is ${humanizeToolName(name).toLowerCase()}...`;
              console.log("[slack-events] updating native T3 tool status", {
                channelId: event.channel,
                threadTs,
                tool: name,
                status,
              });
              await slackStream.setStatus(status);
            }
          : undefined,
      });
    });

    nativeConversation
      .then(async (result) => {
        stopReservationHeartbeat();
        if (result.steered) {
          if (!isDM && slackStream) {
            await slackStream.markRunSucceeded(event.ts);
          }
          await slackRuns.forget(event.channel, event.ts);
          log.info(
            {
              slackUserId: event.user,
              slackChannelId: event.channel,
              slackThreadTs: event.thread_ts ?? event.ts,
              t3ThreadId: result.t3ThreadId,
            },
            "slack follow-up steered active native t3 turn",
          );
          return;
        }
        if (slackDeliveries && slackStream && centralClient) {
          const delivery =
            reservedSlackDelivery ??
            (await slackDeliveries.claimByMessageId(
              result.dispatch.messageId,
            ));
          if (delivery) {
            await deliverClaimedSlackTurn({
              delivery,
              store: slackDeliveries,
              t3: centralClient,
              slack: slackStream,
            });
          }
        } else if (slackStream) {
          await slackStream.postThreadMessage(
            result.output,
            undefined,
            t3SlackSessionLink(result.detailsUrl),
          );
          await slackStream.clearStatus();
        }
        if (!slackDeliveries && !isDM && slackStream) {
          await slackStream.markRunSucceeded(event.ts);
        }
        await slackRuns.forget(event.channel, event.ts);
        console.log(
          `[slack-events] central T3 completed user=${event.user ?? "unknown"} thread=${result.t3ThreadId} provider=${result.modelSelection.instanceId} model=${result.modelSelection.model} resumed=${result.resumed}`,
        );
      })
      .catch(async (err) => {
        stopReservationHeartbeat();
        log.error(
          {
            slackUserId: event.user,
            slackChannelId: event.channel,
            slackThreadTs: event.thread_ts ?? event.ts,
            ...serializeError(err),
          },
          "slack native t3 turn failed",
        );
        if (
          slackDeliveries &&
          slackStream &&
          centralClient &&
          dispatchedMessageId
        ) {
          const delivery =
            reservedSlackDelivery ??
            (await slackDeliveries.claimByMessageId(dispatchedMessageId));
          if (delivery) {
            await deliverClaimedSlackTurn({
              delivery,
              store: slackDeliveries,
              t3: centralClient,
              slack: slackStream,
            });
          }
          return;
        }
        if (slackStream) {
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
): Promise<{
  text: string | null;
  files: SlackFileReference[];
  participantUserIds: string[];
}> {
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
      return { text: null, files: [], participantUserIds: [] };
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
      participantUserIds: messages.flatMap((message) =>
        message.user ? [message.user] : [],
      ),
    };
  } catch (err) {
    console.error("[slack-events] fetchThreadContext error:", err);
    return { text: null, files: [], participantUserIds: [] };
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
