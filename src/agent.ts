import path from "path";
import { fileURLToPath } from "url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_MAX_TURNS, DEFAULT_MAX_BUDGET_USD, DEFAULT_MODEL, FABLE_MODEL, REPO_PATH } from "./config.js";
import { buildMcpServers } from "./mcp.js";
import { getBaseSystemPrompt } from "./prompts/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPADRE_ROOT = path.resolve(__dirname, "..");

const FABLE_FLAG = "--fable";
const FABLE_FLAG_PATTERN = /--fable/g;

export interface TaskResult {
  result: string;
  sessionId: string;
  costUsd: number;
  durationMs: number;
  numTurns: number;
}

export interface StreamCallbacks {
  onTextDelta?: (text: string) => void;
  onToolStart?: (toolName: string) => void;
  onComplete?: () => void;
}

export interface RunTaskOptions {
  prompt: string;
  sessionId?: string;
  systemPrompt?: string;
  worktreePath?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  stream?: StreamCallbacks;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMessage = any;

function selectModelForPrompt(prompt: string): { prompt: string; model: string; fableRequested: boolean } {
  if (!prompt.includes(FABLE_FLAG)) {
    return { prompt, model: DEFAULT_MODEL, fableRequested: false };
  }

  const cleanedPrompt = prompt
    .replace(FABLE_FLAG_PATTERN, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    prompt: cleanedPrompt || prompt,
    model: FABLE_MODEL,
    fableRequested: true,
  };
}

export async function runTask({
  prompt,
  sessionId: resumeSessionId,
  systemPrompt,
  worktreePath,
  maxTurns = DEFAULT_MAX_TURNS,
  maxBudgetUsd = DEFAULT_MAX_BUDGET_USD,
  stream: streamCallbacks,
}: RunTaskOptions): Promise<TaskResult> {
  const cwd = worktreePath ?? REPO_PATH;
  const selected = selectModelForPrompt(prompt);
  if (!systemPrompt) {
    systemPrompt = getBaseSystemPrompt(cwd);
  }

  const mcpServers = await buildMcpServers();

  const stream = query({
    prompt: selected.prompt,
    options: {
      cwd,
      env: {
        ...process.env as Record<string, string>,
        GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(cwd)),
      },
      model: selected.model,
      systemPrompt,
      maxTurns,
      maxBudgetUsd,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      settingSources: ["project"],
      plugins: [
        { type: "local" as const, path: COMPADRE_ROOT },
        { type: "local" as const, path: path.resolve(cwd) },
      ],
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      allowedTools: [
        "Skill",
        "Agent",
        "TaskOutput",
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
        "mcp__jam__*",
        "mcp__render__*",
        "mcp__comp_app__*",
        "mcp__postgres__*",
        "mcp__s3__*",
        "mcp__vitally__*",
        "mcp__google_workspace__*",
      ],
      mcpServers,
    },
  });

  let sessionId: string | undefined;
  let hasStreamedText = false;
  const seenToolUseIds = new Set<string>();

  try {
    for await (const message of stream) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        console.log(`[agent] session ${resumeSessionId ? "resumed" : "started"}: ${sessionId}`);
      }

      if (message.type === "stream_event") {
        const event = (message as AnyMessage).event;
        if (event.type === "content_block_start" && event.content_block?.type === "text") {
          if (hasStreamedText) {
            streamCallbacks?.onTextDelta?.("\n\n");
          }
          hasStreamedText = true;
        }
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          streamCallbacks?.onTextDelta?.(event.delta.text);
        }
      }

      if (message.type === "assistant") {
        const msg = (message as AnyMessage).message;
        const newToolBlocks = (msg.content ?? []).filter((block: AnyMessage) => {
          if (block.type !== "tool_use" || seenToolUseIds.has(block.id)) return false;
          seenToolUseIds.add(block.id);
          return true;
        });

        for (const block of newToolBlocks) {
          streamCallbacks?.onToolStart?.(block.name);
        }

        for (const block of (msg.content ?? []).filter((b: AnyMessage) => b.type === "text")) {
          console.log(`[agent] ${block.text.slice(0, 200)}`);
        }
      }

      if (message.type === "result") {
        const resultMsg = message as AnyMessage;

        if (resultMsg.subtype === "success") {
          return {
            result: resultMsg.result,
            sessionId: sessionId ?? resumeSessionId ?? "",
            costUsd: resultMsg.total_cost_usd,
            durationMs: resultMsg.duration_ms,
            numTurns: resultMsg.num_turns,
          };
        }
        throw new Error(
          `Agent task failed (${resultMsg.subtype}): ${
            "errors" in resultMsg
              ? (resultMsg.errors as string[]).join(", ")
              : "unknown error"
          }`
        );
      }
    }

    throw new Error("Agent stream ended without result");
  } finally {
    streamCallbacks?.onComplete?.();
  }
}
