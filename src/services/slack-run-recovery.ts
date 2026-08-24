const SLACK_API = "https://slack.com/api";
const THINKING_REACTION = "compadre-thinking";
const FAILURE_REACTION = "compadre-failure";
export const DEFAULT_SLACK_RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000;
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
  resolveRun(
    channel: string,
    messageTs: string,
  ): Promise<{ status: string } | null>;
  forgetRun?(channel: string, messageTs: string): Promise<void>;
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, "info" | "warn">;
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
    const current = Promise.resolve()
      .then(recover)
      .finally(() => {
        if (active === current) active = undefined;
      });
    active = current;
    return current;
  };
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
    () =>
      abortController.abort(
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
 * Reconcile Slack's durable reactions with the authoritative durable run.
 * Missing correlations remain untouched: elapsed time is never evidence that
 * a long-running agent failed.
 */
export async function recoverStaleSlackRuns({
  botToken,
  resolveRun,
  forgetRun,
  fetchImpl = fetch,
  logger = console,
  requestTimeoutMs = DEFAULT_SLACK_RECOVERY_REQUEST_TIMEOUT_MS,
}: SlackRunRecoveryOptions): Promise<SlackRunRecoveryResult> {
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
    {
      channel: string;
      messageTs: string;
      threadTs: string;
      botIsThinking: boolean;
      botMarkedFailed: boolean;
    }
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
      const botIsThinking = message?.reactions?.some(
        (reaction) =>
          reaction.name === THINKING_REACTION &&
          reaction.users?.includes(auth.user_id!),
      );
      const botMarkedFailed = message?.reactions?.some(
        (reaction) =>
          reaction.name === FAILURE_REACTION &&
          reaction.users?.includes(auth.user_id!),
      );
      if (
        item.type === "message" &&
        channel &&
        messageTs &&
        (botIsThinking || botMarkedFailed)
      ) {
        stale.set(`${channel}:${messageTs}`, {
          channel,
          messageTs,
          threadTs: message.thread_ts ?? messageTs,
          botIsThinking: botIsThinking === true,
          botMarkedFailed: botMarkedFailed === true,
        });
      }
    }

    cursor = page.response_metadata?.next_cursor?.trim() ?? "";
  } while (cursor);

  let recovered = 0;
  for (const run of stale.values()) {
    let record = await resolveRun(run.channel, run.messageTs);
    if (!record) continue;
    let mutated = false;

    const remove = async (name: string) => {
      const response = await slackCall(
        fetchImpl,
        botToken,
        "reactions.remove",
        boundedTimeoutMs,
        { channel: run.channel, timestamp: run.messageTs, name },
      );
      return response.ok === true || response.error === "no_reaction";
    };
    const add = async (name: string) => {
      const response = await slackCall(
        fetchImpl,
        botToken,
        "reactions.add",
        boundedTimeoutMs,
        { channel: run.channel, timestamp: run.messageTs, name },
      );
      return response.ok === true || response.error === "already_reacted";
    };

    let reconciled = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const active =
        record.status === "running" || record.status === "interrupted";
      const succeeded = record.status === "completed";
      const failed = record.status === "failed" || record.status === "aborted";
      if (!active && !succeeded && !failed) break;

      let mutationSucceeded = true;
      if (active) {
        if (run.botMarkedFailed) {
          mutationSucceeded = await remove(FAILURE_REACTION);
          if (mutationSucceeded) {
            run.botMarkedFailed = false;
            mutated = true;
          }
        }
        if (mutationSucceeded && !run.botIsThinking) {
          mutationSucceeded = await add(THINKING_REACTION);
          if (mutationSucceeded) {
            run.botIsThinking = true;
            mutated = true;
          }
        }
      } else if (succeeded) {
        if (run.botIsThinking) {
          mutationSucceeded = await remove(THINKING_REACTION);
          if (mutationSucceeded) {
            run.botIsThinking = false;
            mutated = true;
          }
        }
        if (mutationSucceeded && run.botMarkedFailed) {
          mutationSucceeded = await remove(FAILURE_REACTION);
          if (mutationSucceeded) {
            run.botMarkedFailed = false;
            mutated = true;
          }
        }
      } else {
        if (run.botIsThinking) {
          mutationSucceeded = await remove(THINKING_REACTION);
          if (mutationSucceeded) {
            run.botIsThinking = false;
            mutated = true;
          }
        }
        if (mutationSucceeded && !run.botMarkedFailed) {
          mutationSucceeded = await add(FAILURE_REACTION);
          if (mutationSucceeded) {
            run.botMarkedFailed = true;
            mutated = true;
          }
        }
      }
      if (!mutationSucceeded) break;

      if (!active) {
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
        await forgetRun?.(run.channel, run.messageTs);
        reconciled = true;
        break;
      }

      const latest = await resolveRun(run.channel, run.messageTs);
      if (!latest) {
        // Successful delivery removes its durable correlation only after it
        // clears both reactions. If that raced this active reconciliation,
        // restore the completed state rather than resurrecting activity.
        if (run.botIsThinking) {
          reconciled = await remove(THINKING_REACTION);
          if (reconciled) {
            run.botIsThinking = false;
            mutated = true;
          }
        } else {
          reconciled = true;
        }
        if (reconciled && run.botMarkedFailed) {
          reconciled = await remove(FAILURE_REACTION);
          if (reconciled) {
            run.botMarkedFailed = false;
            mutated = true;
          }
        }
        break;
      }
      if (latest.status === record.status) {
        reconciled = true;
        break;
      }
      record = latest;
    }
    if (!reconciled) {
      logger.warn("[slack-recovery] reaction reconciliation failed", {
        channel: run.channel,
        messageTs: run.messageTs,
        status: record.status,
      });
      continue;
    }
    if (mutated) recovered += 1;
  }

  if (recovered > 0) {
    logger.info(
      `[slack-recovery] reconciled ${recovered} durable run reaction${recovered === 1 ? "" : "s"}`,
    );
  }
  return { recovered, scanned };
}
