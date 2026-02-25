import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildMcpServers } from "./mcp.js";
import { BASE_SYSTEM_PROMPT } from "./prompts/index.js";
import { resetToQa } from "./repo.js";

interface TaskResult {
  result: string;
  costUsd: number;
  durationMs: number;
  numTurns: number;
}

interface RunTaskOptions {
  prompt: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
}

export async function runTask({
  prompt,
  maxTurns = 30,
  maxBudgetUsd = 2.0,
}: RunTaskOptions): Promise<TaskResult> {
  const repoPath = process.env.REPO_PATH || "/opt/render/repo";

  // Start from clean qa state
  resetToQa();

  const mcpServers = await buildMcpServers();

  const stream = query({
    prompt,
    options: {
      cwd: repoPath,
      env: process.env as Record<string, string>,
      systemPrompt: `${BASE_SYSTEM_PROMPT}`,
      maxTurns,
      maxBudgetUsd,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      allowedTools: [
        // Built-in tools
        "Read",
        "Glob",
        "Grep",
        "Bash",
        "Edit",
        "Write",
        "WebSearch",
        "WebFetch",
        // MCP tools - wildcard per server
        "mcp__datadog-mcp__*",
        "mcp__slack__*",
        "mcp__linear__*",
        "mcp__github__*",
        "mcp__render__*",
        "mcp__postgres__*",
      ],
      mcpServers,
    },
  });

  let sessionId: string | undefined;

  try {
    for await (const message of stream) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        console.log(`[agent] session started: ${sessionId}`);
      }

      // Log assistant text for debugging
      if (message.type === "assistant") {
        const textBlocks = message.message.content.filter(
          (b: { type: string }) => b.type === "text"
        );
        for (const block of textBlocks) {
          console.log(
            `[agent] ${(block as { type: "text"; text: string }).text.slice(0, 200)}`
          );
        }
      }

      if (message.type === "result") {
        if (message.subtype === "success") {
          return {
            result: message.result,
            costUsd: message.total_cost_usd,
            durationMs: message.duration_ms,
            numTurns: message.num_turns,
          };
        }
        throw new Error(
          `Agent task failed (${message.subtype}): ${
            "errors" in message
              ? (message.errors as string[]).join(", ")
              : "unknown error"
          }`
        );
      }
    }

    throw new Error("Agent stream ended without result");
  } finally {
    resetToQa();
  }
}
