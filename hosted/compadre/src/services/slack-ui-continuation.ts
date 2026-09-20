import type { HostedSlackBinding } from "./hosted-thread-bindings.js";
import { SlackClient } from "./slack-client.js";

export const UI_CONTINUATION_REACTION = "compadre-new-message-sent-from-ui";

interface SlackThreadMessage {
  ts?: unknown;
  user?: unknown;
}

interface SlackThreadPage {
  messages?: unknown;
  response_metadata?: unknown;
}

interface SlackUiContinuationClient {
  getAuthIdentity(): Promise<Record<string, unknown>>;
  getThreadReplies(
    channel: string,
    threadTs: string,
    limit?: number,
    cursor?: string,
  ): Promise<Record<string, unknown>>;
  addReaction(
    channel: string,
    timestamp: string,
    reaction: string,
  ): Promise<Record<string, unknown>>;
}

function nextCursor(page: SlackThreadPage): string {
  const metadata = page.response_metadata;
  if (!metadata || typeof metadata !== "object") return "";
  const cursor = (metadata as { next_cursor?: unknown }).next_cursor;
  return typeof cursor === "string" ? cursor.trim() : "";
}

function timestampBefore(ts: unknown, beforeMs: number): number | null {
  if (typeof ts !== "string") return null;
  const seconds = Number(ts);
  if (!Number.isFinite(seconds) || seconds * 1_000 > beforeMs) return null;
  return seconds;
}

/** Mark the latest Compadre-authored Slack message before a web continuation. */
export async function markSlackThreadContinuedInUi(input: {
  client: SlackUiContinuationClient;
  binding: Pick<HostedSlackBinding, "channelId" | "threadTs">;
  beforeMs: number;
  botUserId?: string;
}): Promise<string | null> {
  let botUserId = input.botUserId?.trim();
  if (!botUserId) {
    const auth = await input.client.getAuthIdentity();
    botUserId = typeof auth.user_id === "string" ? auth.user_id.trim() : "";
  }
  if (!botUserId) throw new Error("Slack auth.test did not return a bot user id");

  let latest: { ts: string; seconds: number } | null = null;
  let cursor = "";
  const seenCursors = new Set<string>();
  do {
    const page = await input.client.getThreadReplies(
      input.binding.channelId,
      input.binding.threadTs,
      200,
      cursor || undefined,
    ) as SlackThreadPage;
    const messages = Array.isArray(page.messages)
      ? page.messages as SlackThreadMessage[]
      : [];
    for (const message of messages) {
      if (message.user !== botUserId || typeof message.ts !== "string") continue;
      const seconds = timestampBefore(message.ts, input.beforeMs);
      if (seconds === null || (latest && seconds <= latest.seconds)) continue;
      latest = { ts: message.ts, seconds };
    }
    cursor = nextCursor(page);
    if (cursor && seenCursors.has(cursor)) {
      throw new Error("Slack conversations.replies repeated its cursor");
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor);

  if (!latest) return null;
  try {
    await input.client.addReaction(
      input.binding.channelId,
      latest.ts,
      UI_CONTINUATION_REACTION,
    );
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("already_reacted")) {
      throw error;
    }
  }
  return latest.ts;
}

export async function markConfiguredSlackThreadContinuedInUi(input: {
  binding: Pick<HostedSlackBinding, "channelId" | "threadTs">;
  beforeMs: number;
  environment?: NodeJS.ProcessEnv;
}): Promise<string | null> {
  const environment = input.environment ?? process.env;
  const botToken = environment.SLACK_BOT_TOKEN?.trim();
  const teamId =
    environment.COMPADRE_SLACK_WORKSPACE_ID?.trim() ||
    environment.SLACK_TEAM_ID?.trim();
  if (!botToken || !teamId) return null;
  return markSlackThreadContinuedInUi({
    client: new SlackClient({ botToken, teamId }),
    binding: input.binding,
    beforeMs: input.beforeMs,
    botUserId: environment.SLACK_BOT_USER_ID,
  });
}
