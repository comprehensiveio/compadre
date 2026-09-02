import {
  SLACK_STREAM_CONTENT_LIMIT,
  SLACK_TRUNCATION_NOTICE,
  slackMarkdownMessageContent,
  type SlackSessionLink,
} from "./slack-markdown.js";

const SLACK_API = "https://slack.com/api";
const FLUSH_INTERVAL_MS = 500;
// Slack removes assistant thread statuses after two minutes when no message has
// been sent. Refresh comfortably inside that window so long-running tool work
// remains visibly active before the first response text is available.
const STATUS_REFRESH_INTERVAL_MS = 90 * 1_000;
const NATIVE_STREAM_KEEPALIVE_MS = 4 * 60 * 1_000;
const NATIVE_STREAM_KEEPALIVE = "\u200B";

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
  statusRefreshIntervalMs?: number;
  nativeStreamKeepaliveMs?: number;
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
  private statusRefreshIntervalMs: number;
  private nativeStreamKeepaliveMs: number;
  private logger: Pick<Console, "info" | "warn" | "error">;
  private lastStatus = "";
  private statusUpdating: Promise<void> = Promise.resolve();
  private activeStreamTs: string | null = null;
  private deliveryMode: DeliveryMode = "unstarted";
  private needsFinalRecovery = false;
  private nativeStreamExpired = false;
  private streamEnded = false;
  private buffer = "";
  private fullText = "";
  private truncated = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private statusRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
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
    statusRefreshIntervalMs = STATUS_REFRESH_INTERVAL_MS,
    nativeStreamKeepaliveMs = NATIVE_STREAM_KEEPALIVE_MS,
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
    this.statusRefreshIntervalMs = statusRefreshIntervalMs;
    this.nativeStreamKeepaliveMs = nativeStreamKeepaliveMs;
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
      if (this.lastStatus === text && !this.streamEnded) {
        this.scheduleStatusRefresh();
      }
    });
    await this.statusUpdating;
  }

  async clearStatus(): Promise<void> {
    if (!this.enableStatus) return;
    if (this.statusRefreshTimer) {
      clearTimeout(this.statusRefreshTimer);
      this.statusRefreshTimer = null;
    }
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

  private scheduleStatusRefresh(): void {
    if (this.statusRefreshTimer) clearTimeout(this.statusRefreshTimer);
    if (
      this.statusRefreshIntervalMs <= 0 ||
      this.streamEnded ||
      !this.lastStatus
    ) {
      this.statusRefreshTimer = null;
      return;
    }
    this.statusRefreshTimer = setTimeout(() => {
      this.statusRefreshTimer = null;
      this.statusUpdating = this.statusUpdating.then(() =>
        this.refreshCurrentStatus(),
      );
    }, this.statusRefreshIntervalMs);
    this.statusRefreshTimer.unref();
  }

  private async refreshCurrentStatus(): Promise<void> {
    const status = this.lastStatus;
    if (this.streamEnded || !status) return;
    await this.call("assistant.threads.setStatus", {
      channel_id: this.channel,
      thread_ts: this.threadTs,
      status,
    });
    if (this.lastStatus === status && !this.streamEnded) {
      this.scheduleStatusRefresh();
    }
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

  async markRunStarted(messageTs: string): Promise<void> {
    // A previous relay may have incorrectly terminalized this message while
    // the durable run remained active. Starting is authoritative.
    await this.removeReactionIfPresent("compadre-failure", messageTs);
    await this.addReaction("compadre-thinking", messageTs);
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
  async postThreadMessage(
    markdownText: string,
    clientMsgId?: string,
    sessionLink?: SlackSessionLink,
  ): Promise<void> {
    await this.call("chat.postMessage", {
      channel: this.channel,
      thread_ts: this.threadTs,
      ...slackMarkdownMessageContent(markdownText, sessionLink),
      ...(clientMsgId ? { client_msg_id: clientMsgId } : {}),
    });
  }

  async stopStream(): Promise<void> {
    this.streamEnded = true;
    if (this.statusRefreshTimer) {
      clearTimeout(this.statusRefreshTimer);
      this.statusRefreshTimer = null;
    }
    if (this.keepaliveTimer) {
      clearTimeout(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
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
    this.nativeStreamExpired = false;
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
        this.nativeStreamExpired = false;
        this.logger.info("[slack-stream] native stream started", {
          ...this.logContext(),
          characters: text.length,
        });
        this.scheduleNativeStreamKeepalive();
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
      if (this.nativeStreamExpired) {
        if (await this.rotateNativeStream(text)) return;
      }
      const data = await this.call("chat.appendStream", {
        channel: this.channel,
        ts: this.activeStreamTs,
        markdown_text: text,
      });
      if (!data.ok) {
        if (
          data.error === "message_not_in_streaming_state" &&
          (await this.rotateNativeStream(text))
        ) {
          return;
        }
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
      } else {
        this.scheduleNativeStreamKeepalive();
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

  private async rotateNativeStream(text: string): Promise<boolean> {
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
    const previousStreamTs = this.activeStreamTs;
    const data = await this.call("chat.startStream", startBody);
    if (!data.ok || typeof data.ts !== "string") return false;
    this.activeStreamTs = data.ts;
    this.nativeStreamExpired = false;
    this.logger.info("[slack-stream] native stream rotated", {
      ...this.logContext(),
      previousStreamTs,
      characters: text.length,
    });
    this.scheduleNativeStreamKeepalive();
    return true;
  }

  private scheduleNativeStreamKeepalive(): void {
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    if (
      this.nativeStreamKeepaliveMs <= 0 ||
      this.streamEnded ||
      this.deliveryMode !== "native"
    ) {
      this.keepaliveTimer = null;
      return;
    }
    this.keepaliveTimer = setTimeout(() => {
      this.keepaliveTimer = null;
      this.flushing = this.flushing.then(() => this.keepNativeStreamAlive());
    }, this.nativeStreamKeepaliveMs);
    this.keepaliveTimer.unref();
  }

  private async keepNativeStreamAlive(): Promise<void> {
    if (
      this.streamEnded ||
      this.deliveryMode !== "native" ||
      !this.activeStreamTs
    ) {
      return;
    }
    const data = await this.call("chat.appendStream", {
      channel: this.channel,
      ts: this.activeStreamTs,
      markdown_text: NATIVE_STREAM_KEEPALIVE,
    });
    if (data.ok) {
      this.logger.info("[slack-stream] native stream keepalive accepted", {
        ...this.logContext(),
      });
      this.scheduleNativeStreamKeepalive();
      return;
    }

    if (data.error === "message_not_in_streaming_state") {
      this.nativeStreamExpired = true;
      this.logger.info("[slack-stream] native stream expired between deltas", {
        ...this.logContext(),
      });
      return;
    }

    this.logger.warn(
      "[slack-stream] native stream expired before keepalive; attempting update fallback",
      { ...this.logContext(), error: data.error },
    );
    const update = await this.call("chat.update", {
      channel: this.channel,
      ts: this.activeStreamTs,
      markdown_text: this.fullText,
    });
    if (update.ok) this.deliveryMode = "updates";
    else this.needsFinalRecovery = true;
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
