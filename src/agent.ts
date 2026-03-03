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
        // Always include partial messages so we can capture message_delta
        // usage events (the assistant message only has placeholder output_tokens).
        includePartialMessages: true,
        settingSources: ["project"],
        plugins: [
          { type: "local" as const, path: COMPADRE_ROOT },
          { type: "local" as const, path: path.resolve(REPO_PATH) },
        ],
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
    const pendingTools = new Map<string, {
      name: string;
      input: unknown;
      span: ddTrace.Span;
      done: (error?: Error) => void;
    }>();
    let hasStreamedText = false;
    let turnNumber = 0;
    // message_delta carries the real output_tokens (the assistant message
    // only has a placeholder value of 1 from message_start).
    // We track it in two places depending on arrival order:
    // - pendingOutputTokens: message_delta arrived BEFORE assistant message
    // - pendingLlmTurn.deltaOutputTokens: message_delta arrived AFTER assistant message
    let pendingOutputTokens: number | undefined;
    // Defer LLM span creation so message_delta has time to arrive.
    // For tool-only turns, message_delta may come AFTER the assistant message.
    let pendingLlmTurn: {
      turnNumber: number;
      model: string;
      inputTokens: number;
      usageOutputTokens: number;
      deltaOutputTokens: number | undefined;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    } | undefined;

    function flushLlmTurn() {
      if (!pendingLlmTurn) return;
      const t = pendingLlmTurn;
      pendingLlmTurn = undefined;
      // Prefer message_delta output_tokens (real value) over msg.usage (placeholder 1).
      // deltaOutputTokens captures the message_delta value regardless of whether
      // it arrived before or after the assistant message (see message_delta handler
      // and assistant handler below).
      const outputTokens = t.deltaOutputTokens ?? t.usageOutputTokens;
      const source = t.deltaOutputTokens != null ? "message_delta" : "msg.usage";
      console.log(`[agent] turn-${t.turnNumber} outputTokens=${outputTokens} (source: ${source}, msg.usage=${t.usageOutputTokens})`);
      llmobs.trace({
        kind: "llm",
        name: `turn-${t.turnNumber}`,
        modelName: t.model,
        modelProvider: "anthropic",
      }, () => {
        llmobs.annotate({
          metrics: {
            inputTokens: t.inputTokens,
            outputTokens,
            totalTokens: t.inputTokens + outputTokens,
            ...(t.cacheReadTokens && { cacheReadTokens: t.cacheReadTokens }),
            ...(t.cacheWriteTokens && { cacheWriteTokens: t.cacheWriteTokens }),
          },
        });
      });
    }

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
          // Capture real output_tokens from message_delta.
          // If pendingLlmTurn exists, the assistant message already arrived —
          // attach directly to the turn. Otherwise, store globally for the
          // upcoming assistant message to pick up.
          if (event.type === "message_delta" && event.usage?.output_tokens != null) {
            if (pendingLlmTurn) {
              pendingLlmTurn.deltaOutputTokens = event.usage.output_tokens;
              console.log(`[agent] message_delta output_tokens=${event.usage.output_tokens} (attached to turn-${pendingLlmTurn.turnNumber})`);
            } else {
              pendingOutputTokens = event.usage.output_tokens;
              console.log(`[agent] message_delta output_tokens=${pendingOutputTokens} (pre-assistant, turn-${turnNumber + 1})`);
            }
          }
        }

        // Flush the previous turn's LLM span before processing a new turn
        // or the final result. We intentionally do NOT flush on "user" messages
        // (tool results) — message_delta for the current turn may arrive after
        // the user message, and flushing too early would miss it and fall back
        // to the placeholder output_tokens value.
        if (message.type === "assistant" || message.type === "result") {
          flushLlmTurn();
        }

        if (message.type === "assistant") {
          const msg = (message as AnyMessage).message;
          turnNumber++;

          // Store turn data — the LLM span is created later by flushLlmTurn()
          // so message_delta has time to arrive with the real output_tokens.
          const usage = msg.usage;
          if (usage) {
            const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
            const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
            const inputTokens = (usage.input_tokens ?? 0) + cacheReadTokens + cacheWriteTokens;
            pendingLlmTurn = {
              turnNumber,
              model: msg.model ?? "unknown",
              inputTokens,
              usageOutputTokens: usage.output_tokens ?? 0,
              deltaOutputTokens: pendingOutputTokens,
              cacheReadTokens,
              cacheWriteTokens,
            };
            pendingOutputTokens = undefined;
          }

          // Start a tool span for each tool_use block. The span stays open
          // (via the done callback) until the matching tool_use_result arrives,
          // giving us real execution duration like the comp repo pattern.
          for (const block of msg.content ?? []) {
            if (block.type === "tool_use") {
              llmobs.trace({ kind: "tool", name: block.name }, (span: AnyMessage, done: (error?: Error) => void) => {
                llmobs.annotate(span, {
                  inputData: JSON.stringify(block.input).slice(0, 2000),
                });
                pendingTools.set(block.id, { name: block.name, input: block.input, span, done });
              });
              streamCallbacks?.onToolStart?.(block.name);
            }
          }

          const textBlocks = (msg.content ?? []).filter((b: AnyMessage) => b.type === "text");
          for (const block of textBlocks) {
            console.log(`[agent] ${block.text.slice(0, 200)}`);
          }
        }

        // Tool result — annotate output and close the pending tool span.
        // The tool_use_id is inside message.content (tool_result blocks), NOT
        // in parent_tool_use_id (which is the nesting context, null for top-level).
        if (message.type === "user") {
          const userMsg = message as AnyMessage;
          const contentBlocks = userMsg.message?.content;
          if (Array.isArray(contentBlocks)) {
            for (const block of contentBlocks) {
              if (block.type === "tool_result" && block.tool_use_id) {
                const toolInfo = pendingTools.get(block.tool_use_id);
                if (toolInfo) {
                  const output = block.content ?? userMsg.tool_use_result;
                  llmobs.annotate(toolInfo.span, {
                    outputData: JSON.stringify(output ?? null).slice(0, 2000),
                  });
                  toolInfo.done();
                  pendingTools.delete(block.tool_use_id);
                }
              }
            }
          }
        }

        if (message.type === "result") {
          const resultMsg = message as AnyMessage;
          if (resultMsg.subtype === "success") {
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
      flushLlmTurn();
      // Close any tool spans that never got a result
      for (const [, toolInfo] of pendingTools) {
        llmobs.annotate(toolInfo.span, { outputData: "no result received" });
        toolInfo.done();
      }
      pendingTools.clear();
      streamCallbacks?.onComplete?.();
      if (!resumeSessionId) {
        resetToQa();
      }
    }
  });
}
