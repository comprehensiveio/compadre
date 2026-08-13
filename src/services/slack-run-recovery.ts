const SLACK_API = "https://slack.com/api";
const THINKING_REACTION = "compadre-thinking";
const FAILURE_REACTION = "compadre-failure";
export const DEFAULT_SLACK_RECOVERY_MIN_AGE_MS = 20 * 60 * 1000;
export const DEFAULT_SLACK_RECOVERY_REQUEST_TIMEOUT_MS = 30_000;
const MAX_SLACK_RECOVERY_REQUEST_TIMEOUT_MS = 20 * 60 * 1000;

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
  now?: () => number;
  minimumAgeMs?: number;
  requestTimeoutMs?: number;
}

/** True only for the persistent process allowed to mutate stale Slack state. */
export function isSlackRecoveryOwner(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment.COMPADRE_PROCESS_ROLE === "relay";
}

/** Coalesce concurrent scheduler ticks while allowing the next tick to retry. */
export function createSingleFlightSlackRecovery(
  recover: () => Promise<SlackRunRecoveryResult>,
): () => Promise<SlackRunRecoveryResult> {
  let active: Promise<SlackRunRecoveryResult> | undefined;
  return () => {
    if (active) return active;
    const current = Promise.resolve().then(recover).finally(() => {
      if (active === current) active = undefined;
    });
    active = current;
    return current;
  };
}

function slackTimestampMs(timestamp: string): number | undefined {
  const value = Number(timestamp);
  return Number.isFinite(value) && value > 0 ? value * 1000 : undefined;
}

async function slackCall(
  fetchImpl: typeof fetch,
  botToken: string,
  method: string,
  requestTimeoutMs: number,
  body?: Record<string, unknown>,
): Promise<SlackApiResponse> {
  return fetchSlackJsonWithDeadline(
    fetchImpl,
    `${SLACK_API}/${method}`,
    {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${botToken}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    requestTimeoutMs,
  );
}

function boundedRequestTimeoutMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_SLACK_RECOVERY_REQUEST_TIMEOUT_MS;
  }
  return Math.min(value, MAX_SLACK_RECOVERY_REQUEST_TIMEOUT_MS);
}

async function fetchSlackJsonWithDeadline(
  fetchImpl: typeof fetch,
  input: string | URL | Request,
  init: RequestInit,
  timeoutMs: number,
): Promise<SlackApiResponse> {
  const abortController = new AbortController();
  const timer = setTimeout(
    () => abortController.abort(
      new Error(`Slack recovery request timed out after ${timeoutMs}ms`),
    ),
    timeoutMs,
  );
  try {
    const response = await fetchImpl(input, {
      ...init,
      signal: abortController.signal,
    });
    return (await response.json()) as SlackApiResponse;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Slack retains reactions across container restarts, so the bot's thinking
 * reaction acts as a durable record of work that did not reach a terminal
 * state. A relay converts only markers older than a complete run's normal
 * lifetime; fresh markers may still belong to an active Workflow task.
 */
export async function recoverStaleSlackRuns({
  botToken,
  fetchImpl = fetch,
  logger = console,
  now = Date.now,
  minimumAgeMs = DEFAULT_SLACK_RECOVERY_MIN_AGE_MS,
  requestTimeoutMs = DEFAULT_SLACK_RECOVERY_REQUEST_TIMEOUT_MS,
}: SlackRunRecoveryOptions): Promise<SlackRunRecoveryResult> {
  const recoveryStartedAt = now();
  const boundedTimeoutMs = boundedRequestTimeoutMs(requestTimeoutMs);
  const auth = await slackCall(
    fetchImpl,
    botToken,
    "auth.test",
    boundedTimeoutMs,
  );
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

    const page = await fetchSlackJsonWithDeadline(
      fetchImpl,
      url,
      { headers: { Authorization: `Bearer ${botToken}` } },
      boundedTimeoutMs,
    );
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
      const messageCreatedAt = messageTs
        ? slackTimestampMs(messageTs)
        : undefined;
      const botIsThinking = message?.reactions?.some(
        (reaction) =>
          reaction.name === THINKING_REACTION &&
          reaction.users?.includes(auth.user_id!),
      );
      if (
        item.type === "message" &&
        channel &&
        messageTs &&
        botIsThinking &&
        messageCreatedAt !== undefined &&
        recoveryStartedAt - messageCreatedAt >= minimumAgeMs
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
      boundedTimeoutMs,
      {
        channel: run.channel,
        timestamp: run.messageTs,
        name: THINKING_REACTION,
      },
    );
    // Another still-live instance may have completed the run after our list
    // call. Only mark failure if this instance actually removed the marker.
    if (!removed.ok) continue;

    const failed = await slackCall(
      fetchImpl,
      botToken,
      "reactions.add",
      boundedTimeoutMs,
      {
        channel: run.channel,
        timestamp: run.messageTs,
        name: FAILURE_REACTION,
      },
    );
    if (!failed.ok) {
      logger.warn(
        `[slack-recovery] reactions.add failed: ${failed.error ?? "unknown error"}`,
      );
      // Preserve the durable marker so a later recovery attempt can retry.
      await slackCall(
        fetchImpl,
        botToken,
        "reactions.add",
        boundedTimeoutMs,
        {
          channel: run.channel,
          timestamp: run.messageTs,
          name: THINKING_REACTION,
        },
      );
      continue;
    }
    await slackCall(
      fetchImpl,
      botToken,
      "assistant.threads.setStatus",
      boundedTimeoutMs,
      {
        channel_id: run.channel,
        thread_ts: run.threadTs,
        status: "",
      },
    );
    recovered += 1;
  }

  if (recovered > 0) {
    logger.info(
      `[slack-recovery] marked ${recovered} interrupted run${recovered === 1 ? "" : "s"} as failed`,
    );
  }
  return { recovered, scanned };
}
