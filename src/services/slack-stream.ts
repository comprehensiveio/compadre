const SLACK_API = "https://slack.com/api";

const STREAM_CHUNKS = 25;
const STREAM_DELAY_MS = 40;

interface StreamOptions {
  channel: string;
  threadTs: string;
  botToken: string;
}

export class SlackStream {
  private channel: string;
  private threadTs: string;
  private botToken: string;
  private lastStatus = "";

  constructor({ channel, threadTs, botToken }: StreamOptions) {
    this.channel = channel;
    this.threadTs = threadTs;
    this.botToken = botToken;
  }

  async setStatus(text: string): Promise<void> {
    if (text === this.lastStatus) return;
    this.lastStatus = text;
    await this.call("assistant.threads.setStatus", {
      channel: this.channel,
      thread_ts: this.threadTs,
      status: text,
    });
  }

  async clearStatus(): Promise<void> {
    await this.call("assistant.threads.setStatus", {
      channel: this.channel,
      thread_ts: this.threadTs,
      status: "",
    });
  }

  async streamResponse(text: string): Promise<void> {
    if (!text.trim()) return;

    const res = await this.call("chat.startStream", {
      channel: this.channel,
      thread_ts: this.threadTs,
    });
    const ts = res.ts as string | undefined;
    if (!ts) {
      // Fallback to regular message if streaming fails
      await this.call("chat.postMessage", {
        channel: this.channel,
        thread_ts: this.threadTs,
        text,
      });
      return;
    }

    const chunkSize = Math.max(1, Math.ceil(text.length / STREAM_CHUNKS));
    for (let i = 0; i < text.length; i += chunkSize) {
      await this.call("chat.appendStream", {
        channel: this.channel,
        ts,
        markdown_text: text.slice(i, i + chunkSize),
      });
      if (i + chunkSize < text.length) {
        await new Promise((r) => setTimeout(r, STREAM_DELAY_MS));
      }
    }

    await this.call("chat.stopStream", {
      channel: this.channel,
      ts,
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
