const SLACK_API = "https://slack.com/api";
const FLUSH_INTERVAL_MS = 150;

interface SlackStreamOptions {
  channel: string;
  threadTs: string;
  botToken: string;
}

export class SlackStream {
  private channel: string;
  private threadTs: string;
  private botToken: string;
  private lastStatus = "";
  private activeStreamTs: string | null = null;
  private buffer = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> = Promise.resolve();

  constructor({ channel, threadTs, botToken }: SlackStreamOptions) {
    this.channel = channel;
    this.threadTs = threadTs;
    this.botToken = botToken;
  }

  async setStatus(text: string): Promise<void> {
    if (text === this.lastStatus) return;
    this.lastStatus = text;
    await this.call("assistant.threads.setStatus", {
      channel_id: this.channel,
      thread_ts: this.threadTs,
      status: text,
    });
  }

  async clearStatus(): Promise<void> {
    await this.call("assistant.threads.setStatus", {
      channel_id: this.channel,
      thread_ts: this.threadTs,
      status: "",
    });
  }

  appendText(text: string): void {
    this.buffer += text;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushing = this.flush();
      }, FLUSH_INTERVAL_MS);
    }
  }

  async stopStream(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushing;
    await this.flush();
    if (!this.activeStreamTs) return;
    await this.call("chat.stopStream", {
      channel: this.channel,
      ts: this.activeStreamTs,
    });
    this.activeStreamTs = null;
  }

  private async flush(): Promise<void> {
    const text = this.buffer;
    if (!text) return;
    this.buffer = "";

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

const TOOL_LABELS: Record<string, string> = {
  Read: "Reading code",
  Glob: "Reading code",
  Grep: "Reading code",
  Bash: "Running command",
  Edit: "Editing code",
  Write: "Writing code",
  WebSearch: "Searching web",
  WebFetch: "Fetching page",
};

const MCP_PREFIXES: Record<string, string> = {
  "mcp__slack__": "Using Slack",
  "mcp__linear__": "Searching Linear",
  "mcp__datadog-mcp__": "Checking Datadog",
  "mcp__github__": "Checking GitHub",
  "mcp__render__": "Checking Render",
  "mcp__postgres__": "Querying database",
};

export function humanizeToolName(toolName: string): string {
  if (TOOL_LABELS[toolName]) return TOOL_LABELS[toolName];
  for (const [prefix, label] of Object.entries(MCP_PREFIXES)) {
    if (toolName.startsWith(prefix)) return label;
  }
  return toolName;
}
