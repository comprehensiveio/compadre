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
  private seenCategories = new Set<string>();

  constructor({ channel, threadTs, botToken }: StartOptions) {
    this.channel = channel;
    this.threadTs = threadTs;
    this.botToken = botToken;
  }

  async start(): Promise<void> {
    const res = await this.call("chat.startStream", {
      channel: this.channel,
      thread_ts: this.threadTs,
      chunks: [{ type: "task_update", id: "init", title: "Starting", status: "in_progress" }],
      task_display_mode: "timeline",
    });
    this.ts = res.ts as string | undefined;
  }

  async toolStarted(toolName: string): Promise<void> {
    if (!this.ts) return;
    const category = humanizeToolName(toolName);
    // Only show each category once
    if (this.seenCategories.has(category)) return;
    this.seenCategories.add(category);

    const chunks: TaskChunk[] = [];
    // Complete "Starting" on the first real tool
    if (this.seenCategories.size === 1) {
      chunks.push({ type: "task_update", id: "init", title: "Starting", status: "complete" });
    }
    chunks.push({ type: "task_update", id: category, title: category, status: "in_progress" });
    await this.call("chat.appendStream", {
      channel: this.channel,
      ts: this.ts,
      chunks,
    });
  }

  async stop(): Promise<void> {
    if (!this.ts) return;
    // Complete all in-progress tasks
    const chunks: TaskChunk[] = [...this.seenCategories].map((cat) => ({
      type: "task_update" as const,
      id: cat,
      title: cat,
      status: "complete" as const,
    }));
    await this.call("chat.stopStream", {
      channel: this.channel,
      ts: this.ts,
      chunks,
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
