import path from "path";
import { fileURLToPath } from "url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import ddTrace from "dd-trace";
import { DEFAULT_MAX_TURNS, DEFAULT_MAX_BUDGET_USD, REPO_PATH } from "./config.js";
import { buildMcpServers } from "./mcp.js";
import { getBaseSystemPrompt } from "./prompts/index.js";
import { resetToQa } from "./repo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPADRE_ROOT = path.resolve(__dirname, "..");

const llmobs = ddTrace.llmobs;

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
  maxTurns?: number;
  maxBudgetUsd?: number;
  stream?: StreamCallbacks;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMessage = any;

export async function runTask({
  prompt,
  sessionId: resumeSessionId,
  systemPrompt = getBaseSystemPrompt(),
  maxTurns = DEFAULT_MAX_TURNS,
  maxBudgetUsd = DEFAULT_MAX_BUDGET_USD,
  stream: streamCallbacks,
}: RunTaskOptions): Promise<TaskResult> {
  return llmobs.trace({ name: "compadre-agent", kind: "agent" }, async () => {
    llmobs.annotate({
      inputData: prompt,
      metadata: { maxTurns, maxBudgetUsd, resumed: !!resumeSessionId },
    });

    if (!resumeSessionId) {
      resetToQa();
    }

    const mcpServers = await buildMcpServers();

    const stream = query({
      prompt,
      options: {
        cwd: REPO_PATH,
        env: {
          ...process.env as Record<string, string>,
          GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(REPO_PATH)),
        },
        systemPrompt,
        maxTurns,
        maxBudgetUsd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: !!streamCallbacks?.onTextDelta,
        settingSources: ["project"],
        plugins: [{ type: "local" as const, path: COMPADRE_ROOT }],
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
    let modelName = "claude-sonnet-4-5-20250929";
    const pendingTools = new Map<string, { name: string; input: unknown }>();
    let hasStreamedText = false;

    try {
      for await (const message of stream) {
        if (message.type === "system" && message.subtype === "init") {
          sessionId = message.session_id;
          modelName = (message as AnyMessage).model ?? modelName;
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

          // LLM span for this API call — output only (per-message usage from
          // the Agent SDK is unreliable; accurate totals come from modelUsage
          // on the result message and are recorded in a summary span below)
          llmobs.trace({
            kind: "llm",
            name: "claude-completion",
            modelName,
            modelProvider: "anthropic",
          }, () => {
            const textOutput = (msg.content ?? [])
              .filter((b: AnyMessage) => b.type === "text")
              .map((b: AnyMessage) => ({ content: b.text, role: "assistant" }));

            llmobs.annotate({ outputData: textOutput });
          });

          // Track tool_use blocks for pairing with results
          for (const block of msg.content ?? []) {
            if (block.type === "tool_use") {
              pendingTools.set(block.id, { name: block.name, input: block.input });
              streamCallbacks?.onToolStart?.(block.name);
            }
          }

          const textBlocks = (msg.content ?? []).filter((b: AnyMessage) => b.type === "text");
          for (const block of textBlocks) {
            console.log(`[agent] ${block.text.slice(0, 200)}`);
          }
        }

        // Tool result — create a tool span with input/output
        if (message.type === "user") {
          const userMsg = message as AnyMessage;
          if (userMsg.tool_use_result !== undefined && userMsg.parent_tool_use_id) {
            const toolInfo = pendingTools.get(userMsg.parent_tool_use_id);
            if (toolInfo) {
              llmobs.trace({ kind: "tool", name: toolInfo.name }, () => {
                llmobs.annotate({
                  inputData: JSON.stringify(toolInfo.input).slice(0, 2000),
                  outputData: JSON.stringify(userMsg.tool_use_result).slice(0, 2000),
                });
              });
              pendingTools.delete(userMsg.parent_tool_use_id);
            }
          }
        }

        if (message.type === "result") {
          const resultMsg = message as AnyMessage;
          if (resultMsg.subtype === "success") {
            // Create a summary LLM span per model with accurate token counts
            // from modelUsage — DD uses these for cost calculation
            const modelUsage = resultMsg.modelUsage ?? {};
            for (const [model, usage] of Object.entries(modelUsage)) {
              const u = usage as AnyMessage;
              const inputTokens = u.inputTokens ?? 0;
              const outputTokens = u.outputTokens ?? 0;
              llmobs.trace({
                kind: "llm",
                name: "claude-usage-summary",
                modelName: model,
                modelProvider: "anthropic",
              }, () => {
                llmobs.annotate({
                  metrics: {
                    inputTokens,
                    outputTokens,
                    totalTokens: inputTokens + outputTokens,
                    ...(u.cacheReadInputTokens && { cacheReadTokens: u.cacheReadInputTokens }),
                    ...(u.cacheCreationInputTokens && { cacheWriteTokens: u.cacheCreationInputTokens }),
                  },
                });
              });
            }

            llmobs.annotate({
              outputData: resultMsg.result,
              metrics: {
                turns: resultMsg.num_turns,
                costUsd: resultMsg.total_cost_usd,
              },
            });
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
      if (!resumeSessionId) {
        resetToQa();
      }
    }
  });
}
