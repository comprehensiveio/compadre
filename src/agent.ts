import { query } from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_MAX_TURNS, DEFAULT_MAX_BUDGET_USD, REPO_PATH } from "./config.js";
import { buildMcpServers } from "./mcp.js";
import { BASE_SYSTEM_PROMPT } from "./prompts/index.js";
import { resetToQa } from "./repo.js";

interface TaskResult {
  result: string;
  sessionId: string;
  costUsd: number;
  durationMs: number;
  numTurns: number;
}

interface RunTaskOptions {
  prompt: string;
  sessionId?: string;
  systemPrompt?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
}

export async function runTask({
  prompt,
  sessionId: resumeSessionId,
  systemPrompt = BASE_SYSTEM_PROMPT,
  maxTurns = DEFAULT_MAX_TURNS,
  maxBudgetUsd = DEFAULT_MAX_BUDGET_USD,
}: RunTaskOptions): Promise<TaskResult> {

  if (!resumeSessionId) {
    resetToQa();
  }

  const mcpServers = await buildMcpServers();

  const stream = query({
    prompt,
    options: {
      cwd: REPO_PATH,
      env: process.env as Record<string, string>,
      systemPrompt,
      maxTurns,
      maxBudgetUsd,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      allowedTools: [
        "Read",
        "Glob",
        "Grep",
        "Bash",
        "Edit",
        "Write",
        "WebSearch",
        "WebFetch",
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
        console.log(`[agent] session ${resumeSessionId ? "resumed" : "started"}: ${sessionId}`);
      }

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
            sessionId: sessionId ?? resumeSessionId ?? "",
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
    if (!resumeSessionId) {
      resetToQa();
    }
  }
}
