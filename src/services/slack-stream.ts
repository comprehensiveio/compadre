import {
  SLACK_STREAM_CONTENT_LIMIT,
  SLACK_TRUNCATION_NOTICE,
  truncateSlackMarkdown,
} from "./slack-markdown.js";

const SLACK_API = "https://slack.com/api";
const FLUSH_INTERVAL_MS = 500;

interface SlackStreamOptions {
  channel: string;
  threadTs: string;
  botToken: string;
  /** User and team are required by Slack when streaming into a channel thread. */
  recipientUserId?: string;
  recipientTeamId?: string;
  /** Disable only for callers that do not want Slack's thread loading state. */
  enableStatus?: boolean;
  fetchImpl?: typeof fetch;
  flushIntervalMs?: number;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

type DeliveryMode = "unstarted" | "native" | "updates";

export class SlackStream {
  private channel: string;
  private threadTs: string;
  private botToken: string;
  private recipientUserId?: string;
  private recipientTeamId?: string;
  private enableStatus: boolean;
  private fetchImpl: typeof fetch;
  private flushIntervalMs: number;
  private logger: Pick<Console, "info" | "warn" | "error">;
  private lastStatus = "";
  private statusUpdating: Promise<void> = Promise.resolve();
  private activeStreamTs: string | null = null;
  private deliveryMode: DeliveryMode = "unstarted";
  private needsFinalRecovery = false;
  private streamEnded = false;
  private buffer = "";
  private fullText = "";
  private truncated = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> = Promise.resolve();

  constructor({
    channel,
    threadTs,
    botToken,
    recipientUserId,
    recipientTeamId,
    enableStatus = true,
    fetchImpl = fetch,
    flushIntervalMs = FLUSH_INTERVAL_MS,
    logger = console,
  }: SlackStreamOptions) {
    this.channel = channel;
    this.threadTs = threadTs;
    this.botToken = botToken;
    this.recipientUserId = recipientUserId;
    this.recipientTeamId = recipientTeamId;
    this.enableStatus = enableStatus;
    this.fetchImpl = fetchImpl;
    this.flushIntervalMs = flushIntervalMs;
    this.logger = logger;
  }

  async setStatus(text: string): Promise<void> {
    if (!this.enableStatus) return;
    if (text === this.lastStatus) return;
    this.lastStatus = text;
    this.statusUpdating = this.statusUpdating.then(async () => {
      await this.call("assistant.threads.setStatus", {
        channel_id: this.channel,
        thread_ts: this.threadTs,
        status: text,
      });
    });
    await this.statusUpdating;
  }

  async clearStatus(): Promise<void> {
    if (!this.enableStatus) return;
    this.lastStatus = "";
    this.statusUpdating = this.statusUpdating.then(async () => {
      await this.call("assistant.threads.setStatus", {
        channel_id: this.channel,
        thread_ts: this.threadTs,
        status: "",
      });
    });
    await this.statusUpdating;
  }

  async addReaction(name: string, messageTs: string): Promise<void> {
    await this.call("reactions.add", {
      channel: this.channel,
      timestamp: messageTs,
      name,
    });
  }

  async removeReaction(name: string, messageTs: string): Promise<void> {
    await this.call("reactions.remove", {
      channel: this.channel,
      timestamp: messageTs,
      name,
    });
  }

  async markRunSucceeded(messageTs: string): Promise<void> {
    await this.removeReactionIfPresent("compadre-thinking", messageTs);
    // A prior process may have raced startup recovery with this live run.
    // Success is authoritative, so clean up any stale failure marker too.
    await this.removeReactionIfPresent("compadre-failure", messageTs);
  }

  async markRunFailed(messageTs: string): Promise<void> {
    await this.removeReactionIfPresent("compadre-thinking", messageTs);
    await this.addReaction("compadre-failure", messageTs);
  }

  private async removeReactionIfPresent(
    name: string,
    messageTs: string,
  ): Promise<void> {
    await this.call(
      "reactions.remove",
      {
        channel: this.channel,
        timestamp: messageTs,
        name,
      },
      new Set(["no_reaction"]),
    );
  }

  /** Returns true only when the complete delta was accepted into the stream. */
  appendText(text: string): boolean {
    if (this.streamEnded || this.truncated || !text) return false;

    const currentLength = this.fullText.length + this.buffer.length;
    const remaining = Math.max(0, SLACK_STREAM_CONTENT_LIMIT - currentLength);
    this.buffer += text.slice(0, remaining);
    const accepted = text.length <= remaining;
    if (text.length > remaining) {
      this.buffer += SLACK_TRUNCATION_NOTICE;
      this.truncated = true;
    }

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushing = this.flushing.then(() => this.flush());
      }, this.flushIntervalMs);
    }
    return accepted;
  }

  hasTruncatedContent(): boolean {
    return this.truncated;
  }

  /** Post a separate thread message that is not subject to this stream's cap. */
  async postThreadMessage(markdownText: string): Promise<void> {
    await this.call("chat.postMessage", {
      channel: this.channel,
      thread_ts: this.threadTs,
      markdown_text: truncateSlackMarkdown(markdownText),
    });
  }

  async stopStream(): Promise<void> {
    this.streamEnded = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushing;
    await this.flush();
    if (!this.activeStreamTs) {
      if (this.fullText) {
        this.logger.error("[slack-stream] response not delivered", {
          ...this.logContext(),
          characters: this.fullText.length,
        });
      }
      return;
    }

    let finalization: string = this.deliveryMode;
    if (this.deliveryMode === "native") {
      const result = await this.call("chat.stopStream", {
        channel: this.channel,
        ts: this.activeStreamTs,
      });
      if (!result.ok || this.needsFinalRecovery) {
        this.logger.warn("[slack-stream] recovering final response", {
          ...this.logContext(),
          stopError: result.error,
          missingBufferedText: this.needsFinalRecovery,
        });
        finalization = await this.finalizeWithUpdateFallback();
      }
    }

    this.logger.info("[slack-stream] response finalized", {
      ...this.logContext(),
      finalization,
      characters: this.fullText.length,
    });
    this.activeStreamTs = null;
    this.deliveryMode = "unstarted";
    this.needsFinalRecovery = false;
  }

  private async flush(): Promise<void> {
    const text = this.buffer;
    if (!text) return;
    this.buffer = "";
    this.fullText += text;

    if (this.deliveryMode === "unstarted") {
      const startBody: Record<string, unknown> = {
        channel: this.channel,
        thread_ts: this.threadTs,
        markdown_text: text,
      };
      if (this.recipientUserId) {
        startBody.recipient_user_id = this.recipientUserId;
      }
      if (this.recipientTeamId) {
        startBody.recipient_team_id = this.recipientTeamId;
      }

      const data = await this.call("chat.startStream", startBody);
      if (data.ok && typeof data.ts === "string") {
        this.activeStreamTs = data.ts;
        this.deliveryMode = "native";
        this.logger.info("[slack-stream] native stream started", {
          ...this.logContext(),
          characters: text.length,
        });
        return;
      }

      this.logger.warn(
        "[slack-stream] native stream unavailable; using message fallback",
        {
          ...this.logContext(),
          error: data.error,
        },
      );
      await this.startUpdateFallback();
      return;
    }

    if (this.deliveryMode === "native" && this.activeStreamTs) {
      const data = await this.call("chat.appendStream", {
        channel: this.channel,
        ts: this.activeStreamTs,
        markdown_text: text,
      });
      if (!data.ok) {
        this.logger.warn(
          "[slack-stream] native stream interrupted; attempting update fallback",
          {
            ...this.logContext(),
            error: data.error,
          },
        );
        const update = await this.call("chat.update", {
          channel: this.channel,
          ts: this.activeStreamTs,
          markdown_text: this.fullText,
        });
        if (update.ok) {
          this.deliveryMode = "updates";
        } else {
          this.needsFinalRecovery = true;
        }
      }
      return;
    }

    if (this.activeStreamTs) {
      await this.call("chat.update", {
        channel: this.channel,
        ts: this.activeStreamTs,
        markdown_text: this.fullText,
      });
    }
  }

  private async startUpdateFallback(): Promise<void> {
    const data = await this.call("chat.postMessage", {
      channel: this.channel,
      thread_ts: this.threadTs,
      markdown_text: this.fullText,
    });
    if (data.ok && typeof data.ts === "string") {
      this.activeStreamTs = data.ts;
      this.deliveryMode = "updates";
    }
  }

  private async finalizeWithUpdateFallback(): Promise<string> {
    if (!this.activeStreamTs) return "failed";

    const update = await this.call("chat.update", {
      channel: this.channel,
      ts: this.activeStreamTs,
      markdown_text: this.fullText,
    });
    if (update.ok) return "update-recovery";

    const post = await this.call("chat.postMessage", {
      channel: this.channel,
      thread_ts: this.threadTs,
      markdown_text: this.fullText,
    });
    return post.ok ? "post-recovery" : "failed";
  }

  private logContext(): Record<string, unknown> {
    return {
      channel: this.channel,
      threadTs: this.threadTs,
      streamTs: this.activeStreamTs,
      deliveryMode: this.deliveryMode,
    };
  }

  private async call(
    method: string,
    body: Record<string, unknown>,
    ignoredErrors: ReadonlySet<string> = new Set(),
  ): Promise<Record<string, unknown> & { ok?: boolean }> {
    try {
      const res = await this.fetchImpl(`${SLACK_API}/${method}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.botToken}`,
        },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as Record<string, unknown> & {
        ok?: boolean;
      };
      if (!data.ok && !ignoredErrors.has(String(data.error))) {
        this.logger.error(`[slack-stream] ${method} failed`, {
          ...this.logContext(),
          error: data.error,
        });
      }
      return data;
    } catch (err) {
      this.logger.error(`[slack-stream] ${method} error`, {
        ...this.logContext(),
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false };
    }
  }
}
