const SLACK_API = "https://slack.com/api";
const THINKING_REACTION = "compadre-thinking";
const FAILURE_REACTION = "compadre-failure";

interface SlackReaction {
  name?: string;
  users?: string[];
}

interface SlackReactionItem {
  type?: string;
  channel?: string;
  message?: {
    ts?: string;
    thread_ts?: string;
    reactions?: SlackReaction[];
  };
}

interface SlackApiResponse {
  ok?: boolean;
  error?: string;
  user_id?: string;
  items?: SlackReactionItem[];
  response_metadata?: { next_cursor?: string };
}

export interface SlackRunRecoveryResult {
  recovered: number;
  scanned: number;
}

interface SlackRunRecoveryOptions {
  botToken: string;
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, "info" | "warn">;
}

async function slackCall(
  fetchImpl: typeof fetch,
  botToken: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<SlackApiResponse> {
  const response = await fetchImpl(`${SLACK_API}/${method}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${botToken}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return (await response.json()) as SlackApiResponse;
}

/**
 * Slack retains reactions across container restarts, so the bot's thinking
 * reaction acts as a durable record of work that did not reach a terminal
 * state. Convert those records to failures after a new instance starts.
 */
export async function recoverStaleSlackRuns({
  botToken,
  fetchImpl = fetch,
  logger = console,
}: SlackRunRecoveryOptions): Promise<SlackRunRecoveryResult> {
  const auth = await slackCall(fetchImpl, botToken, "auth.test");
  if (!auth.ok || !auth.user_id) {
    logger.warn(
      `[slack-recovery] auth.test failed: ${auth.error ?? "missing user_id"}`,
    );
    return { recovered: 0, scanned: 0 };
  }

  const stale = new Map<
    string,
    { channel: string; messageTs: string; threadTs: string }
  >();
  let cursor = "";
  let scanned = 0;

  do {
    const url = new URL(`${SLACK_API}/reactions.list`);
    url.searchParams.set("limit", "200");
    url.searchParams.set("full", "true");
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    const page = (await response.json()) as SlackApiResponse;
    if (!page.ok) {
      logger.warn(
        `[slack-recovery] reactions.list failed: ${page.error ?? "unknown error"}`,
      );
      return { recovered: 0, scanned };
    }

    for (const item of page.items ?? []) {
      scanned += 1;
      const message = item.message;
      const channel = item.channel;
      const messageTs = message?.ts;
      const botIsThinking = message?.reactions?.some(
        (reaction) =>
          reaction.name === THINKING_REACTION &&
          reaction.users?.includes(auth.user_id!),
      );
      if (
        item.type === "message" &&
        channel &&
        messageTs &&
        botIsThinking
      ) {
        stale.set(`${channel}:${messageTs}`, {
          channel,
          messageTs,
          threadTs: message.thread_ts ?? messageTs,
        });
      }
    }

    cursor = page.response_metadata?.next_cursor?.trim() ?? "";
  } while (cursor);

  let recovered = 0;
  for (const run of stale.values()) {
    const removed = await slackCall(
      fetchImpl,
      botToken,
      "reactions.remove",
      {
        channel: run.channel,
        timestamp: run.messageTs,
        name: THINKING_REACTION,
      },
    );
    // Another still-live instance may have completed the run after our list
    // call. Only mark failure if this instance actually removed the marker.
    if (!removed.ok) continue;

    const failed = await slackCall(fetchImpl, botToken, "reactions.add", {
      channel: run.channel,
      timestamp: run.messageTs,
      name: FAILURE_REACTION,
    });
    if (!failed.ok) {
      logger.warn(
        `[slack-recovery] reactions.add failed: ${failed.error ?? "unknown error"}`,
      );
      // Preserve the durable marker so a later recovery attempt can retry.
      await slackCall(fetchImpl, botToken, "reactions.add", {
        channel: run.channel,
        timestamp: run.messageTs,
        name: THINKING_REACTION,
      });
      continue;
    }
    await slackCall(fetchImpl, botToken, "assistant.threads.setStatus", {
      channel_id: run.channel,
      thread_ts: run.threadTs,
      status: "",
    });
    recovered += 1;
  }

  if (recovered > 0) {
    logger.info(
      `[slack-recovery] marked ${recovered} interrupted run${recovered === 1 ? "" : "s"} as failed`,
    );
  }
  return { recovered, scanned };
}
