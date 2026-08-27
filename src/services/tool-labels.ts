const TOOL_LABELS: Record<string, string> = {
  Read: "Reading code",
  Glob: "Reading code",
  Grep: "Reading code",
  Bash: "Running command",
  Edit: "Editing code",
  Write: "Writing code",
  WebSearch: "Searching web",
  WebFetch: "Fetching page",
  "Ran command": "Running command",
  "Read file": "Reading file",
  "Changed files": "Changing files",
  "Searched files": "Searching files",
  "File change": "Changing files",
  "Web search": "Searching web",
  "MCP tool call": "Using MCP tool",
  "Tool call": "Using tool",
};

const MCP_PREFIXES: Record<string, string> = {
  mcp__slack__: "Using Slack",
  mcp__linear__: "Searching Linear",
  "mcp__datadog-mcp__": "Checking Datadog",
  mcp__github__: "Checking GitHub",
  mcp__render__: "Checking Render",
  mcp__comp_app__: "Using Comp app server",
  mcp__postgres__: "Querying database",
};

export function humanizeToolName(toolName: string): string {
  if (TOOL_LABELS[toolName]) return TOOL_LABELS[toolName];
  for (const [prefix, label] of Object.entries(MCP_PREFIXES)) {
    if (toolName.startsWith(prefix)) return label;
  }
  return toolName;
}
