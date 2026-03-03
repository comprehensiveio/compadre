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
    // - turn.deltaOutputTokens: message_delta arrived AFTER assistant message
    let pendingOutputTokens: number | undefined;

    interface TurnData {
      turnNumber: number;
      model: string;
      inputTokens: number;
      usageOutputTokens: number;
      deltaOutputTokens: number | undefined;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      output: string;
    }
    // Collect all turns — LLM spans are created at the end when the result
    // message arrives, so we can reconcile output tokens from the total.
    const completedTurns: TurnData[] = [];
    let currentTurn: TurnData | undefined;

    function finalizeTurn() {
      if (!currentTurn) return;
      completedTurns.push(currentTurn);
      currentTurn = undefined;
    }

    function emitLlmSpans(totalOutputTokens?: number) {
      // If the SDK didn't emit message_delta for some turns (e.g. turn-1),
      // their deltaOutputTokens will be undefined and they fall back to
      // usageOutputTokens (placeholder 1). Use the total from the result
      // message to reconcile: subtract known turns from the total and
      // assign the remainder to the unknown turn.
      let unknownTurns: TurnData[] = [];
      let knownOutputSum = 0;
      for (const t of completedTurns) {
        const known = t.deltaOutputTokens;
        if (known != null) {
          knownOutputSum += known;
        } else {
          unknownTurns.push(t);
        }
      }
      // If exactly one turn is unknown and we have a total, compute by subtraction.
      if (unknownTurns.length === 1 && totalOutputTokens != null) {
        unknownTurns[0].deltaOutputTokens = totalOutputTokens - knownOutputSum;
        console.log(`[agent] reconciled turn-${unknownTurns[0].turnNumber} outputTokens=${unknownTurns[0].deltaOutputTokens} (total=${totalOutputTokens} - known=${knownOutputSum})`);
      }

      for (const t of completedTurns) {
        const outputTokens = t.deltaOutputTokens ?? t.usageOutputTokens;
        const source = t.deltaOutputTokens != null ? "message_delta" : "msg.usage";
        console.log(`[agent] turn-${t.turnNumber} outputTokens=${outputTokens} (source: ${source})`);
        llmobs.trace({
          kind: "llm",
          name: `turn-${t.turnNumber}`,
          modelName: t.model,
          modelProvider: "anthropic",
        }, () => {
          llmobs.annotate({
            inputData: `[turn ${t.turnNumber} — ${t.inputTokens} input tokens]`,
            outputData: t.output,
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
      completedTurns.length = 0;
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
          // If currentTurn exists, the assistant message already arrived —
          // attach directly to the turn. Otherwise, store globally for the
          // upcoming assistant message to pick up.
          if (event.type === "message_delta" && event.usage?.output_tokens != null) {
            if (currentTurn) {
              currentTurn.deltaOutputTokens = event.usage.output_tokens;
              console.log(`[agent] message_delta output_tokens=${event.usage.output_tokens} (attached to turn-${currentTurn.turnNumber})`);
            } else {
              pendingOutputTokens = event.usage.output_tokens;
              console.log(`[agent] message_delta output_tokens=${pendingOutputTokens} (pre-assistant, turn-${turnNumber + 1})`);
            }
          }
        }

        // Finalize the current turn when a new assistant message or result arrives.
        // We don't finalize on "user" messages (tool results) because
        // message_delta may still arrive after the user message.
        if (message.type === "assistant" || message.type === "result") {
          finalizeTurn();
        }

        if (message.type === "assistant") {
          const msg = (message as AnyMessage).message;
          turnNumber++;

          // Store turn data — LLM spans are emitted later by emitLlmSpans()
          // when the result arrives, allowing output token reconciliation.
          const usage = msg.usage;
          if (usage) {
            const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
            const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
            const inputTokens = (usage.input_tokens ?? 0) + cacheReadTokens + cacheWriteTokens;
            // Summarize the assistant output for the LLM span annotation.
            const outputParts: string[] = [];
            for (const block of msg.content ?? []) {
              if (block.type === "text") {
                outputParts.push(block.text);
              } else if (block.type === "tool_use") {
                outputParts.push(`[tool_use: ${block.name}]`);
              }
            }

            currentTurn = {
              turnNumber,
              model: msg.model ?? "unknown",
              inputTokens,
              usageOutputTokens: usage.output_tokens ?? 0,
              deltaOutputTokens: pendingOutputTokens,
              cacheReadTokens,
              cacheWriteTokens,
              output: outputParts.join("\n").slice(0, 2000),
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
            // Emit all LLM spans now that we have the total output tokens
            // from the result for reconciliation. modelUsage has the aggregate
            // across all turns; usage.output_tokens is only the last message.
            const modelUsage = resultMsg.modelUsage as Record<string, { outputTokens?: number }> | undefined;
            let totalOutputTokens: number | undefined;
            if (modelUsage) {
              totalOutputTokens = 0;
              for (const mu of Object.values(modelUsage)) {
                totalOutputTokens += mu.outputTokens ?? 0;
              }
            }
            console.log(`[agent] result totalOutputTokens=${totalOutputTokens}`);
            emitLlmSpans(totalOutputTokens);
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
      finalizeTurn();
      // Emit LLM spans without reconciliation (no result total available)
      if (completedTurns.length > 0) {
        emitLlmSpans();
      }
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
