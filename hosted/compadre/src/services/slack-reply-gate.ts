import type { TypeSafeClient, Usage } from "@typesafe-ai/sdk";
import { log, serializeError } from "../logging.js";
import type { SlackEvent } from "../routes/slack-events.js";
import type { HostedThreadBindingStore } from "./hosted-thread-bindings.js";
import { canonicalSlackThreadId } from "./t3-slack-conversation.js";
import { centralT3ThreadId } from "../t3/central-conversation.js";
import type { T3Client } from "../t3/client.js";
import { configuredTypeSafeClient } from "./typesafe-client.js";

/**
 * Untagged Slack thread reply experiment.
 *
 * "jev": a reply inside a Compadre-bound Slack thread that does not mention
 *   the bot is judged by TypeSafe's Jev model. When Jev says the reply is
 *   addressed to Compadre, the reply is routed exactly like a mention: a new
 *   turn on the thread, or a steer when a turn is already running.
 * "off": untagged replies are ignored, the pre-experiment behavior.
 *
 * Code-level kill switch. The gate is also inert when TYPESAFE_API_KEY is
 * missing, so a missing credential degrades to "off" instead of failing
 * ingress.
 */
export const SLACK_UNTAGGED_REPLY_GATE: "jev" | "off" = "jev";

/**
 * Decision thresholds, evaluated on real thread samples via
 * `npm run slack:reply-gate-probe`. Acting on a false "respond" posts an
 * unwanted agent turn into a human conversation, so the bar for responding is
 * high; missing a true "respond" only costs the user a mention.
 */
export const SLACK_REPLY_RESPOND_THRESHOLD = 0.7;
export const SLACK_REPLY_SIDE_CONVERSATION_THRESHOLD = 0.5;

const MAX_THREAD_MESSAGES = 25;
const MAX_MESSAGE_CHARS = 1_500;

export type SlackReplyGateMessage = {
  author: string;
  from_agent: boolean;
  text: string;
};

/**
 * The state Jev judges. Field names are referenced from the questions. Type
 * aliases (not interfaces) so the object is assignable to the SDK's JSON
 * state type without a cast.
 */
export type SlackReplyGateState = {
  agent_name: "Compadre";
  agent_is_working: boolean;
  thread: SlackReplyGateMessage[];
  reply: { author: string; text: string; has_attachments: boolean };
};

export interface SlackReplyJudgement {
  wantsAgentAction: number;
  humanSideConversation: number;
  model: string;
  usage?: Usage;
}

export type SlackReplyJudge = (
  state: SlackReplyGateState,
) => Promise<SlackReplyJudgement>;

export interface SlackThreadMessage {
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  files?: unknown[];
}

export type SlackThreadLoader = (input: {
  channel: string;
  threadTs: string;
}) => Promise<SlackThreadMessage[]>;

export type SlackReplyGateOutcome =
  | { outcome: "respond"; reason: "directed_at_agent"; judgement: SlackReplyJudgement }
  | {
      outcome: "ignore";
      reason: "not_directed" | "human_side_conversation" | "judge_failed";
      judgement?: SlackReplyJudgement;
    }
  | { outcome: "skip"; reason: "thread_not_bound" };

const SLACK_REPLY_QUESTIONS = {
  wants_agent_action: {
    type: "noul",
    instructions:
      "Is `reply` directed at the coding agent named in `agent_name` — asking it to do something, answer something, or change what it is doing in this thread? The agent's earlier messages have `from_agent: true`. People often address the agent without tagging it: by name, or implicitly by continuing or correcting the request they gave it. When `agent_is_working` is true, telling the agent to wait, stop, or adjust also counts.",
    criteria: {
      true:
        "The reply asks the agent to act, answer, fix, continue, stop, or redirect its work, including feedback on its last answer that calls for a follow-up from it.",
      false:
        "The reply is a reaction, acknowledgement, or thanks; a human talking to another human; a status note or FYI; or anything that expects no response from the agent.",
    },
  },
  human_side_conversation: {
    type: "noul",
    instructions:
      "Is `reply` part of a conversation between the humans in this thread (or a note to themselves), rather than a message meant for the agent named in `agent_name`?",
  },
} as const;

let cachedJudge: SlackReplyJudge | null | undefined;

/** Resolve the configured judge once; null when the experiment is off. */
export function configuredSlackReplyJudge(
  environment: NodeJS.ProcessEnv = process.env,
): SlackReplyJudge | null {
  if (SLACK_UNTAGGED_REPLY_GATE !== "jev") return null;
  if (cachedJudge !== undefined) return cachedJudge;
  const client = configuredTypeSafeClient(environment);
  cachedJudge = client ? createJevSlackReplyJudge(client) : null;
  return cachedJudge;
}

export function resetConfiguredSlackReplyJudgeForTests(): void {
  cachedJudge = undefined;
}

export function createJevSlackReplyJudge(
  client: Pick<TypeSafeClient, "systemOne">,
): SlackReplyJudge {
  return async (state) => {
    const result = await client.systemOne({
      state,
      questions: SLACK_REPLY_QUESTIONS,
    });
    return {
      wantsAgentAction: result.answers.wants_agent_action.noul,
      humanSideConversation: result.answers.human_side_conversation.noul,
      model: result.model,
      usage: result.usage,
    };
  };
}

/**
 * A channel message that replies inside an existing thread without tagging
 * the bot. DMs and mentions already route; attachment-only replies stay out
 * because there is no text to judge.
 */
export function isUntaggedThreadReplyCandidate(
  event: SlackEvent,
  botUserId?: string,
): boolean {
  if (SLACK_UNTAGGED_REPLY_GATE !== "jev") return false;
  if (event.bot_id) return false;
  if (event.type !== "message") return false;
  if (event.subtype !== undefined && event.subtype !== "file_share") return false;
  if (event.channel.startsWith("D")) return false;
  if (!event.thread_ts || event.thread_ts === event.ts) return false;
  if (!event.text?.trim()) return false;
  if (botUserId && event.text.includes(`<@${botUserId}>`)) return false;
  return true;
}

/** Only threads Compadre already participates in are eligible for judging. */
export async function isCompadreBoundSlackThread(input: {
  bindings: Pick<HostedThreadBindingStore, "slack">;
  teamId?: string;
  channel: string;
  threadTs: string;
}): Promise<boolean> {
  const canonicalThreadId = canonicalSlackThreadId({
    teamId: input.teamId,
    channel: input.channel,
    threadTs: input.threadTs,
  });
  const binding = await input.bindings.slack(
    centralT3ThreadId(canonicalThreadId),
  );
  return (
    binding !== null &&
    binding.channelId === input.channel &&
    binding.threadTs === input.threadTs
  );
}

function clip(text: string): string {
  const normalized = text.trim();
  return normalized.length > MAX_MESSAGE_CHARS
    ? `${normalized.slice(0, MAX_MESSAGE_CHARS)}…`
    : normalized;
}

export function buildSlackReplyGateState(input: {
  event: SlackEvent;
  botUserId?: string;
  threadMessages: SlackThreadMessage[];
  agentIsWorking: boolean;
}): SlackReplyGateState {
  const isAgent = (message: SlackThreadMessage) =>
    Boolean(message.bot_id) ||
    (Boolean(input.botUserId) && message.user === input.botUserId);
  const thread = input.threadMessages
    .filter((message) => message.ts !== input.event.ts)
    .filter((message) => message.text?.trim())
    .slice(-MAX_THREAD_MESSAGES)
    .map((message) => ({
      author: isAgent(message) ? "Compadre" : message.user ?? "unknown",
      from_agent: isAgent(message),
      text: clip(message.text ?? ""),
    }));
  return {
    agent_name: "Compadre",
    agent_is_working: input.agentIsWorking,
    thread,
    reply: {
      author: input.event.user ?? "unknown",
      text: clip(input.event.text),
      has_attachments: (input.event.files?.length ?? 0) > 0,
    },
  };
}

/** Turn raw probabilities into the routing decision; thresholds live in code. */
export function decideSlackReply(
  judgement: SlackReplyJudgement,
): Exclude<SlackReplyGateOutcome, { outcome: "skip" }> {
  if (judgement.humanSideConversation > SLACK_REPLY_SIDE_CONVERSATION_THRESHOLD) {
    return { outcome: "ignore", reason: "human_side_conversation", judgement };
  }
  if (judgement.wantsAgentAction < SLACK_REPLY_RESPOND_THRESHOLD) {
    return { outcome: "ignore", reason: "not_directed", judgement };
  }
  return { outcome: "respond", reason: "directed_at_agent", judgement };
}

/**
 * Judge one untagged reply. Fails closed: any judge or Slack read failure
 * becomes "ignore" so a flaky dependency never produces an unwanted turn and
 * never requeues the durable inbox row.
 */
export async function gateUntaggedSlackReply(input: {
  event: SlackEvent;
  teamId?: string;
  botUserId?: string;
  bindings: Pick<HostedThreadBindingStore, "slack">;
  centralClient?: Pick<T3Client, "snapshot"> | null;
  loadThread: SlackThreadLoader;
  judge: SlackReplyJudge;
}): Promise<SlackReplyGateOutcome> {
  const { event } = input;
  const threadTs = event.thread_ts ?? event.ts;
  const teamId = event.user_team || event.team || input.teamId;
  const canonicalThreadId = canonicalSlackThreadId({
    teamId,
    channel: event.channel,
    threadTs,
  });
  const context = {
    canonicalThreadId,
    slackChannelId: event.channel,
    slackThreadTs: threadTs,
    slackTs: event.ts,
    slackUserId: event.user,
  };

  if (
    !(await isCompadreBoundSlackThread({
      bindings: input.bindings,
      teamId,
      channel: event.channel,
      threadTs,
    }))
  ) {
    return { outcome: "skip", reason: "thread_not_bound" };
  }

  const startedAt = Date.now();
  try {
    const [threadMessages, agentIsWorking] = await Promise.all([
      input.loadThread({ channel: event.channel, threadTs }),
      isAgentWorking(input.centralClient, canonicalThreadId),
    ]);
    const state = buildSlackReplyGateState({
      event,
      botUserId: input.botUserId,
      threadMessages,
      agentIsWorking,
    });
    const judgement = await input.judge(state);
    const decision = decideSlackReply(judgement);
    log.info(
      {
        ...context,
        outcome: decision.outcome,
        reason: decision.reason,
        wantsAgentAction: judgement.wantsAgentAction,
        humanSideConversation: judgement.humanSideConversation,
        agentIsWorking,
        threadMessageCount: state.thread.length,
        model: judgement.model,
        inputTokens: judgement.usage?.input_tokens,
        elapsedMs: Date.now() - startedAt,
      },
      "slack untagged reply judged",
    );
    return decision;
  } catch (error) {
    log.warn(
      { ...context, elapsedMs: Date.now() - startedAt, ...serializeError(error) },
      "slack untagged reply judgement failed; ignoring reply",
    );
    return { outcome: "ignore", reason: "judge_failed" };
  }
}

async function isAgentWorking(
  client: Pick<T3Client, "snapshot"> | null | undefined,
  canonicalThreadId: string,
): Promise<boolean> {
  if (!client) return false;
  const threadId = centralT3ThreadId(canonicalThreadId);
  const snapshot = await client.snapshot();
  return (
    snapshot.threads.find((thread) => thread.id === threadId)?.latestTurn
      ?.state === "running"
  );
}

/** Read the thread's recent messages from Slack for the judge. */
export function slackThreadLoader(botToken: string): SlackThreadLoader {
  return async ({ channel, threadTs }) => {
    const response = await fetch(
      `https://slack.com/api/conversations.replies?${new URLSearchParams({
        channel,
        ts: threadTs,
        limit: String(MAX_THREAD_MESSAGES + 1),
      })}`,
      { headers: { Authorization: `Bearer ${botToken}` } },
    );
    const data = (await response.json()) as {
      ok: boolean;
      messages?: SlackThreadMessage[];
      error?: string;
    };
    if (!data.ok || !data.messages) {
      throw new Error(
        `conversations.replies failed: ${data.error ?? "unknown error"}`,
      );
    }
    return data.messages;
  };
}
