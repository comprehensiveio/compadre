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
