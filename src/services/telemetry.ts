import ddTrace from "dd-trace";

const llmobs = ddTrace.llmobs;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMessage = any;

interface TurnData {
  turnNumber: number;
  model: string;
  inputTokens: number;
  usageOutputTokens: number;
  deltaOutputTokens: number | undefined;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputContent: string;
  textContent: string;
  toolParts: string[];
  span: AnyMessage;
  doneSpan: (error?: Error) => void;
  recordedEndTime: number | undefined;
}

/**
 * Manages Datadog LLMobs telemetry spans and token reconciliation for agent runs.
 * Must be instantiated inside the outer llmobs.trace() callback to preserve span nesting.
 */
export class AgentTelemetryTracker {
  private pendingTools = new Map<string, {
    name: string;
    input: unknown;
    span: ddTrace.Span;
    done: (error?: Error) => void;
  }>();
  private currentTurn: TurnData | undefined;
  private pendingOutputTokens: number | undefined;
  private reconciliationQueue: TurnData[] = [];
  private closedOutputSum = 0;
  private turnNumber = 0;
  private lastMessageId: string | undefined;
  private seenToolUseIds = new Set<string>();
  private bufferedInputContent: string[] = [];

  constructor(private prompt: string) {}

  /** Handle a stream_event from the SDK. Returns nothing — side effects only. */
  onStreamEvent(event: AnyMessage): void {
    // Capture real output_tokens from message_delta.
    if (event.type === "message_delta" && event.usage?.output_tokens != null) {
      if (this.currentTurn && this.currentTurn.deltaOutputTokens === undefined) {
        // message_delta arrived AFTER the assistant message for this
        // turn (delta-after ordering). Attach directly to the turn.
        this.currentTurn.deltaOutputTokens = event.usage.output_tokens;
        console.log(`[agent] message_delta output_tokens=${event.usage.output_tokens} (attached to turn-${this.currentTurn.turnNumber})`);
      } else {
        // Either no currentTurn yet (first turn) or currentTurn
        // already has its delta (meaning this delta belongs to the
        // NEXT turn, i.e. delta-before ordering). Stash it so the
        // upcoming assistant message picks it up.
        this.pendingOutputTokens = event.usage.output_tokens;
        console.log(`[agent] message_delta output_tokens=${this.pendingOutputTokens} (pending for next turn, current=${this.currentTurn ? `turn-${this.currentTurn.turnNumber}` : "none"})`);
      }
    }
  }

  /** Call when an assistant message arrives. Opens turn + tool spans.
   *  Returns the list of newly-seen tool_use blocks (for onToolStart callbacks). */
  onAssistantMessage(msg: AnyMessage): AnyMessage[] {
    const messageId = msg.id as string | undefined;
    const isSameMessage = messageId != null && messageId === this.lastMessageId;
    const isUpdate = isSameMessage && this.currentTurn != null;

    if (!isUpdate) {
      // New API call (or first partial before currentTurn exists) —
      // finalize previous turn and start a new one.
      this.finalizeTurn();
      this.turnNumber++;
      this.lastMessageId = messageId;
    }

    const usage = msg.usage;

    if (usage && !isUpdate) {
      const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
      const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
      const inputTokens = (usage.input_tokens ?? 0) + cacheReadTokens + cacheWriteTokens;

      const inputContent = this.turnNumber === 1
        ? this.prompt
        : this.bufferedInputContent.join("\n").slice(0, 4000) || `[turn ${this.turnNumber} continuation]`;
      this.bufferedInputContent = [];

      llmobs.trace({
        kind: "llm",
        name: `turn-${this.turnNumber}`,
        modelName: msg.model ?? "unknown",
        modelProvider: "anthropic",
      }, (span: AnyMessage, done: (error?: Error) => void) => {
        this.currentTurn = {
          turnNumber: this.turnNumber,
          model: msg.model ?? "unknown",
          inputTokens,
          usageOutputTokens: usage.output_tokens ?? 0,
          deltaOutputTokens: this.pendingOutputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          inputContent,
          textContent: "",
          toolParts: [],
          span,
          doneSpan: done,
          recordedEndTime: undefined,
        };
        this.pendingOutputTokens = undefined;
      });
    } else if (isUpdate && this.currentTurn) {
      if (usage) {
        this.currentTurn.usageOutputTokens = usage.output_tokens ?? 0;
      }
    }

    // Update text content from the latest message (text grows with partials).
    if (this.currentTurn) {
      const textParts: string[] = [];
      for (const block of msg.content ?? []) {
        if (block.type === "text") textParts.push(block.text);
      }
      if (textParts.length > 0) {
        this.currentTurn.textContent = textParts.join("\n");
      }
    }

    // Start tool spans only for newly-seen tool_use blocks.
    const newToolBlocks: AnyMessage[] = [];
    for (const block of msg.content ?? []) {
      if (block.type === "tool_use" && !this.seenToolUseIds.has(block.id)) {
        this.seenToolUseIds.add(block.id);
        newToolBlocks.push(block);
        if (this.currentTurn) {
          const inputStr = JSON.stringify(block.input).slice(0, 500);
          this.currentTurn.toolParts.push(`[tool_use: ${block.name}] ${inputStr}`);
        }
        llmobs.trace({ kind: "tool", name: block.name }, (span: AnyMessage, done: (error?: Error) => void) => {
          llmobs.annotate(span, {
            inputData: JSON.stringify(block.input).slice(0, 2000),
          });
          this.pendingTools.set(block.id, { name: block.name, input: block.input, span, done });
        });
      }
    }

    return newToolBlocks;
  }

  /** Call when a user (tool result) message arrives. Closes matching tool spans. */
  onUserMessage(msg: AnyMessage): void {
    const contentBlocks = msg.message?.content;
    if (!Array.isArray(contentBlocks)) return;

    for (const block of contentBlocks) {
      if (block.type === "tool_result" && block.tool_use_id) {
        const toolInfo = this.pendingTools.get(block.tool_use_id);
        if (toolInfo) {
          const output = block.content ?? msg.tool_use_result;
          llmobs.annotate(toolInfo.span, {
            outputData: JSON.stringify(output ?? null).slice(0, 2000),
          });
          this.bufferedInputContent.push(`[${toolInfo.name} result]: ${JSON.stringify(output ?? null).slice(0, 500)}`);
          toolInfo.done();
          this.pendingTools.delete(block.tool_use_id);
        }
      }
    }
  }

  /** Call when a result message arrives. Reconciles tokens and annotates the agent span. */
  onResult(resultMsg: AnyMessage): void {
    this.finalizeTurn();

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
    this.reconcileAndClose(totalOutputTokens);

    llmobs.annotate({
      outputData: resultMsg.result ?? "",
      metrics: {
        turns: resultMsg.num_turns,
        costUsd: resultMsg.total_cost_usd,
      },
    });
  }

  /** Clean up any open spans (call in finally block). */
  cleanup(): void {
    this.finalizeTurn();
    this.reconcileAndClose();
    for (const [, toolInfo] of this.pendingTools) {
      llmobs.annotate(toolInfo.span, { outputData: "no result received" });
      toolInfo.done();
    }
    this.pendingTools.clear();
  }

  private annotateTurn(t: TurnData, outputTokens: number) {
    const outputParts = [t.textContent, ...t.toolParts].filter(Boolean);
    llmobs.annotate(t.span, {
      inputData: t.inputContent,
      outputData: outputParts.join("\n").slice(0, 4000),
      metrics: {
        inputTokens: t.inputTokens,
        outputTokens,
        totalTokens: t.inputTokens + outputTokens,
        ...(t.cacheReadTokens && { cacheReadTokens: t.cacheReadTokens }),
        ...(t.cacheWriteTokens && { cacheWriteTokens: t.cacheWriteTokens }),
      },
    });
  }

  private closeTurnSpan(t: TurnData) {
    if (t.recordedEndTime !== undefined) {
      (t.span as ddTrace.Span).finish(t.recordedEndTime);
    }
    t.doneSpan();
  }

  private finalizeTurn() {
    if (!this.currentTurn) return;
    const t = this.currentTurn;
    this.currentTurn = undefined;
    t.recordedEndTime = Date.now();

    if (t.deltaOutputTokens !== undefined) {
      const outputTokens = t.deltaOutputTokens;
      console.log(`[agent] turn-${t.turnNumber} outputTokens=${outputTokens} (source: message_delta)`);
      this.annotateTurn(t, outputTokens);
      this.closeTurnSpan(t);
      this.closedOutputSum += outputTokens;
    } else {
      console.log(`[agent] turn-${t.turnNumber} queued for reconciliation (no message_delta yet)`);
      this.reconciliationQueue.push(t);
    }
  }

  private reconcileAndClose(totalOutputTokens?: number) {
    if (this.reconciliationQueue.length === 0) return;

    if (this.reconciliationQueue.length === 1 && totalOutputTokens != null) {
      const t = this.reconciliationQueue[0];
      const outputTokens = Math.max(0, totalOutputTokens - this.closedOutputSum);
      console.log(`[agent] reconciled turn-${t.turnNumber} outputTokens=${outputTokens} (total=${totalOutputTokens} - closed=${this.closedOutputSum})`);
      this.annotateTurn(t, outputTokens);
    } else {
      for (const t of this.reconciliationQueue) {
        const outputTokens = t.usageOutputTokens;
        console.log(`[agent] turn-${t.turnNumber} outputTokens=${outputTokens} (source: msg.usage fallback)`);
        this.annotateTurn(t, outputTokens);
      }
    }

    for (const t of this.reconciliationQueue) {
      this.closeTurnSpan(t);
    }
    this.reconciliationQueue.length = 0;
  }
}
