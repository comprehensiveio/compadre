const SLACK_API = "https://slack.com/api";
const FLUSH_INTERVAL_MS = 500;

interface SlackStreamOptions {
  channel: string;
  threadTs: string;
  botToken: string;
  /** When false, setStatus/clearStatus become no-ops (assistant API only works in DMs). */
  enableStatus?: boolean;
}

export class SlackStream {
  private channel: string;
  private threadTs: string;
  private botToken: string;
  private enableStatus: boolean;
  private lastStatus = "";
  private activeStreamTs: string | null = null;
  private streamEnded = false;
  private buffer = "";
  private fullText = ""; // accumulated text for chat.update in channels
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> = Promise.resolve();

  constructor({ channel, threadTs, botToken, enableStatus = true }: SlackStreamOptions) {
    this.channel = channel;
    this.threadTs = threadTs;
    this.botToken = botToken;
    this.enableStatus = enableStatus;
  }

  async setStatus(text: string): Promise<void> {
    if (!this.enableStatus) return;
    if (text === this.lastStatus) return;
    this.lastStatus = text;
    await this.call("assistant.threads.setStatus", {
      channel_id: this.channel,
      thread_ts: this.threadTs,
      status: text,
    });
  }

  async clearStatus(): Promise<void> {
    if (!this.enableStatus) return;
    await this.call("assistant.threads.setStatus", {
      channel_id: this.channel,
      thread_ts: this.threadTs,
      status: "",
    });
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

  appendText(text: string): void {
    if (this.streamEnded) return;
    this.buffer += text;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushing = this.flush();
      }, FLUSH_INTERVAL_MS);
    }
  }

  async stopStream(): Promise<void> {
    this.streamEnded = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushing;
    await this.flush();
    if (!this.activeStreamTs) return;
    if (this.enableStatus) {
      // Assistant streaming API — finalize the stream
      await this.call("chat.stopStream", {
        channel: this.channel,
        ts: this.activeStreamTs,
      });
    }
    this.activeStreamTs = null;
  }

  private async flush(): Promise<void> {
    const text = this.buffer;
    if (!text) return;
    this.buffer = "";
    this.fullText += text;

    if (this.enableStatus) {
      // DM assistant mode: use streaming API
      if (!this.activeStreamTs) {
        const data = await this.call("chat.startStream", {
          channel: this.channel,
          thread_ts: this.threadTs,
        });
        this.activeStreamTs = (data.ts as string) ?? null;
        if (!this.activeStreamTs) return;
      }
      await this.call("chat.appendStream", {
        channel: this.channel,
        ts: this.activeStreamTs,
        markdown_text: text,
      });
    } else {
      // Channel mode: use postMessage + update
      if (!this.activeStreamTs) {
        const data = await this.call("chat.postMessage", {
          channel: this.channel,
          thread_ts: this.threadTs,
          text: this.fullText,
        });
        this.activeStreamTs = (data.ts as string) ?? null;
      } else {
        await this.call("chat.update", {
          channel: this.channel,
          ts: this.activeStreamTs,
          text: this.fullText,
        });
      }
    }
  }

  private async call(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const res = await fetch(`${SLACK_API}/${method}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.botToken}`,
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) {
        console.error(`[slack-stream] ${method} failed:`, data.error);
      }
      return data as Record<string, unknown>;
    } catch (err) {
      console.error(`[slack-stream] ${method} error:`, err);
      return { ok: false };
    }
  }
}
