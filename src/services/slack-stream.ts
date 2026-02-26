const SLACK_API = "https://slack.com/api";

interface TaskChunk {
  type: "task_update";
  id: string;
  title: string;
  status: "pending" | "in_progress" | "complete" | "error";
}

interface StartOptions {
  channel: string;
  threadTs: string;
  botToken: string;
}

export class SlackStream {
  private channel: string;
  private threadTs: string;
  private botToken: string;
  private ts: string | undefined;

  constructor({ channel, threadTs, botToken }: StartOptions) {
    this.channel = channel;
    this.threadTs = threadTs;
    this.botToken = botToken;
  }

  async start(): Promise<void> {
    const res = await this.call("chat.startStream", {
      channel: this.channel,
      thread_ts: this.threadTs,
      markdown_text: "_Working on it..._",
    });
    this.ts = res.ts as string | undefined;
  }

  async appendTask(id: string, title: string, status: TaskChunk["status"]): Promise<void> {
    if (!this.ts) return;
    const chunk: TaskChunk = { type: "task_update", id, title, status };
    await this.call("chat.appendStream", {
      channel: this.channel,
      ts: this.ts,
      chunks: [chunk],
    });
  }

  async stop(): Promise<void> {
    if (!this.ts) return;
    await this.call("chat.stopStream", {
      channel: this.channel,
      ts: this.ts,
    });
    this.ts = undefined;
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
  Read: "Reading file",
  Glob: "Finding files",
  Grep: "Searching code",
  Bash: "Running command",
  Edit: "Editing code",
  Write: "Writing file",
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
