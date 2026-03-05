import path from "path";
import { fileURLToPath } from "url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import ddTrace from "dd-trace";
import { DEFAULT_MAX_TURNS, DEFAULT_MAX_BUDGET_USD, REPO_PATH } from "./config.js";
import { buildMcpServers } from "./mcp.js";
import { getBaseSystemPrompt } from "./prompts/index.js";

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
  worktreePath?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  stream?: StreamCallbacks;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMessage = any;

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
  // Default system prompt uses the effective cwd so the agent sees the correct path
  if (!systemPrompt) {
    systemPrompt = getBaseSystemPrompt(cwd);
  }

  return llmobs.trace({ name: "compadre-agent", kind: "agent" }, async () => {
    llmobs.annotate({
      inputData: prompt,
      metadata: { maxTurns, maxBudgetUsd, resumed: !!resumeSessionId },
    });

    const mcpServers = await buildMcpServers();

    const stream = query({
      prompt,
      options: {
        cwd,
        env: {
          ...process.env as Record<string, string>,
          GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(cwd)),
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
          { type: "local" as const, path: path.resolve(cwd) },
        ],
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        allowedTools: [
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
      // Span is opened in real-time when the assistant message arrives.
      // doneSpan is called (after annotation) to close it.
      span: AnyMessage;
      doneSpan: (error?: Error) => void;
      // Recorded when the turn logically ends so we can back-date the span
      // finish time even if we must defer annotation for reconciliation.
      recordedEndTime: number | undefined;
    }
    // Turns whose deltaOutputTokens is still unknown are deferred here until
    // the result message arrives with a total we can reconcile against.
    const reconciliationQueue: TurnData[] = [];
    // Sum of output tokens for turns already closed — used for reconciliation.
    let closedOutputSum = 0;
    let currentTurn: TurnData | undefined;

    function annotateTurn(t: TurnData, outputTokens: number) {
      llmobs.annotate(t.span, {
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
    }

    function closeTurnSpan(t: TurnData) {
      // Back-date the span finish time to when the turn logically ended so
      // the flame graph reflects real duration rather than reconciliation lag.
      if (t.recordedEndTime !== undefined) {
        (t.span as ddTrace.Span).finish(t.recordedEndTime);
      }
      t.doneSpan();
    }

    function finalizeTurn() {
      if (!currentTurn) return;
      const t = currentTurn;
      currentTurn = undefined;
      t.recordedEndTime = Date.now();

      if (t.deltaOutputTokens !== undefined) {
        // We have the real token count — annotate and close immediately.
        const outputTokens = t.deltaOutputTokens;
        console.log(`[agent] turn-${t.turnNumber} outputTokens=${outputTokens} (source: message_delta)`);
        annotateTurn(t, outputTokens);
        closeTurnSpan(t);
        closedOutputSum += outputTokens;
      } else {
        // message_delta hasn't arrived yet — defer annotation until we can
        // reconcile output tokens from the result total.
        console.log(`[agent] turn-${t.turnNumber} queued for reconciliation (no message_delta yet)`);
        reconciliationQueue.push(t);
      }
    }

    function reconcileAndClose(totalOutputTokens?: number) {
      if (reconciliationQueue.length === 0) return;

      // If exactly one turn is unknown and we have a total, compute by subtraction.
      if (reconciliationQueue.length === 1 && totalOutputTokens != null) {
        const t = reconciliationQueue[0];
        const outputTokens = Math.max(0, totalOutputTokens - closedOutputSum);
        console.log(`[agent] reconciled turn-${t.turnNumber} outputTokens=${outputTokens} (total=${totalOutputTokens} - closed=${closedOutputSum})`);
        annotateTurn(t, outputTokens);
      } else {
        // Multiple unknown turns or no total available — fall back to
        // usageOutputTokens (placeholder, but better than nothing).
        for (const t of reconciliationQueue) {
          const outputTokens = t.usageOutputTokens;
          console.log(`[agent] turn-${t.turnNumber} outputTokens=${outputTokens} (source: msg.usage fallback)`);
          annotateTurn(t, outputTokens);
        }
      }

      for (const t of reconciliationQueue) {
        closeTurnSpan(t);
      }
      reconciliationQueue.length = 0;
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

          // Open the LLM span now so its start time reflects when the turn
          // actually began. We annotate and close it in finalizeTurn() (or
          // reconcileAndClose() if output tokens need reconciliation).
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

            llmobs.trace({
              kind: "llm",
              name: `turn-${turnNumber}`,
              modelName: msg.model ?? "unknown",
              modelProvider: "anthropic",
            }, (span: AnyMessage, done: (error?: Error) => void) => {
              currentTurn = {
                turnNumber,
                model: msg.model ?? "unknown",
                inputTokens,
                usageOutputTokens: usage.output_tokens ?? 0,
                deltaOutputTokens: pendingOutputTokens,
                cacheReadTokens,
                cacheWriteTokens,
                output: outputParts.join("\n").slice(0, 2000),
                span,
                doneSpan: done,
                recordedEndTime: undefined,
              };
              pendingOutputTokens = undefined;
            });
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
              let sum = 0;
              let hasOutputTokens = false;
              for (const mu of Object.values(modelUsage)) {
                if (typeof mu.outputTokens === "number") {
                  sum += mu.outputTokens;
                  hasOutputTokens = true;
                }
              }
              totalOutputTokens = hasOutputTokens ? sum : undefined;
            }
            console.log(`[agent] result totalOutputTokens=${totalOutputTokens}`);
            reconcileAndClose(totalOutputTokens);
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
      // Close any deferred spans without reconciliation (error/abort path —
      // no result total available, so fall back to usageOutputTokens).
      reconcileAndClose();
      // Close any tool spans that never got a result
      for (const [, toolInfo] of pendingTools) {
        llmobs.annotate(toolInfo.span, { outputData: "no result received" });
        toolInfo.done();
      }
      pendingTools.clear();
      streamCallbacks?.onComplete?.();
    }
  });
}
