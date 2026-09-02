import {
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  metrics,
  trace as otelTrace,
  type Attributes,
  type Context,
  type Histogram,
  type Meter,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { EventType, type StreamChunk } from "@tanstack/ai";
import { AssistantMessageAccumulator } from "./assistant-messages.js";
import type { HarnessSelection } from "./harness.js";
import {
  TELEMETRY_MAX_CONTENT_LENGTH,
  createTelemetryContentRedactor,
  genAiMessagesAttribute,
  serializeTelemetryValue,
} from "./telemetry-content.js";

export type WorktreeSource = "existing" | "prepared" | "on-demand";

export type HarnessRuntimePhase =
  | "queue.thread"
  | "queue.capacity"
  | "worktree.allocate"
  | "mcp.initialize"
  | "stream.initialize";

export interface HarnessRunTelemetryOptions {
  selection: HarnessSelection;
  threadId: string;
  runId: string;
  tracer?: Tracer;
  meter?: Meter;
  now?: () => number;
  input?: unknown;
  environment?: NodeJS.ProcessEnv;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Owns the coarse, request-wide trace around queueing, worktree allocation,
 * harness startup, and the existing fine-grained TanStack GenAI spans.
 */
export class HarnessRunTelemetry {
  private readonly tracer: Tracer;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly runSpan: Span;
  private readonly runContext: Context;
  private readonly firstEventSpan: Span;
  private readonly firstTextSpan: Span;
  private readonly phaseDuration: Histogram;
  private readonly milestoneDuration: Histogram;
  private readonly runDuration: Histogram;
  private readonly memoryUsage: Histogram;
  private readonly selection: HarnessSelection;
  private readonly assistantMessages = new AssistantMessageAccumulator();
  private readonly redactContent: (value: string) => string;
  private worktreeSource: WorktreeSource | undefined;
  private firstEventObserved = false;
  private firstTextObserved = false;
  private terminalError: Error | undefined;
  private peakTreeRssBytes = 0;
  private peakHostUsageBytes = 0;
  private ended = false;

  constructor({
    selection,
    threadId,
    runId,
    tracer = otelTrace.getTracer("compadre.runtime"),
    meter = metrics.getMeter("compadre.runtime"),
    now = Date.now,
    input,
    environment = process.env,
  }: HarnessRunTelemetryOptions) {
    this.tracer = tracer;
    this.now = now;
    this.startedAt = now();
    this.selection = selection;
    this.redactContent = createTelemetryContentRedactor(environment);
    this.runSpan = tracer.startSpan("compadre.agent.run", {
      kind: SpanKind.INTERNAL,
      startTime: this.startedAt,
      attributes: {
        "agui.thread_id": threadId,
        "agui.run_id": runId,
        "agent.provider": selection.provider,
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.conversation.id": threadId,
        "gen_ai.provider.name":
          selection.provider === "codex" ? "openai" : "anthropic",
        "gen_ai.request.model": selection.model,
      },
    });
    this.runContext = otelTrace.setSpan(otelContext.active(), this.runSpan);
    if (input !== undefined) {
      const inputMessages = genAiMessagesAttribute(
        "user",
        serializeTelemetryValue(input, TELEMETRY_MAX_CONTENT_LENGTH),
        this.redactContent,
      );
      this.runSpan.setAttribute("gen_ai.input.messages", inputMessages);
      this.runSpan.setAttribute("langfuse.observation.input", inputMessages);
      this.runSpan.setAttribute("langfuse.trace.input", inputMessages);
    }
    this.firstEventSpan = tracer.startSpan(
      "compadre.agent.wait.first_event",
      { kind: SpanKind.INTERNAL, startTime: this.startedAt },
      this.runContext,
    );
    this.firstTextSpan = tracer.startSpan(
      "compadre.agent.wait.first_text",
      { kind: SpanKind.INTERNAL, startTime: this.startedAt },
      this.runContext,
    );
    this.phaseDuration = meter.createHistogram(
      "compadre.agent.phase.duration",
      { unit: "ms", description: "Harness runtime phase duration" },
    );
    this.milestoneDuration = meter.createHistogram(
      "compadre.agent.milestone.duration",
      {
        unit: "ms",
        description: "Time from request start to a user-visible milestone",
      },
    );
    this.runDuration = meter.createHistogram("compadre.agent.run.duration", {
      unit: "ms",
      description: "End-to-end harness run duration",
    });
    this.memoryUsage = meter.createHistogram("compadre.agent.memory.usage", {
      unit: "By",
      description: "Sampled agent process-tree and service-cgroup memory",
    });
  }

  private metricAttributes(extra: Attributes = {}): Attributes {
    return {
      "agent.provider": this.selection.provider,
      ...(this.worktreeSource
        ? { "worktree.source": this.worktreeSource }
        : {}),
      ...extra,
    };
  }

  setWorktree(worktreeId: string, source: WorktreeSource): void {
    this.worktreeSource = source;
    this.runSpan.setAttributes({
      "worktree.id": worktreeId,
      "worktree.source": source,
    });
    this.firstEventSpan.setAttribute("worktree.source", source);
    this.firstTextSpan.setAttribute("worktree.source", source);
  }

  async phase<T>(phase: HarnessRuntimePhase, task: () => Promise<T>): Promise<T> {
    const startedAt = this.now();
    const span = this.tracer.startSpan(
      `compadre.agent.${phase}`,
      {
        kind: SpanKind.INTERNAL,
        startTime: startedAt,
        attributes: this.metricAttributes({ "compadre.phase": phase }),
      },
      this.runContext,
    );
    const phaseContext = otelTrace.setSpan(this.runContext, span);
    let outcome = "success";
    try {
      return await otelContext.with(phaseContext, task);
    } catch (error) {
      outcome = "error";
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: errorMessage(error),
      });
      throw error;
    } finally {
      const finishedAt = this.now();
      this.phaseDuration.record(
        finishedAt - startedAt,
        this.metricAttributes({
          "compadre.phase": phase,
          "compadre.outcome": outcome,
        }),
        this.runContext,
      );
      span.end(finishedAt);
    }
  }

  inContext<T>(task: () => T): T {
    return otelContext.with(this.runContext, task);
  }

  observe(chunk: StreamChunk): void {
    this.assistantMessages.observe(chunk);
    if (!this.firstEventObserved) {
      this.firstEventObserved = true;
      this.recordMilestone("first_event");
      this.firstEventSpan.setAttribute("compadre.milestone.reached", true);
      this.firstEventSpan.end(this.now());
    }
    if (
      !this.firstTextObserved &&
      chunk.type === EventType.TEXT_MESSAGE_CONTENT
    ) {
      this.firstTextObserved = true;
      this.recordMilestone("first_text");
      this.firstTextSpan.setAttribute("compadre.milestone.reached", true);
      this.firstTextSpan.end(this.now());
    }
    if (chunk.type === EventType.RUN_ERROR) {
      this.terminalError = new Error(chunk.message || "Agent run failed");
    }
  }

  observeMemory(
    treeRssBytes: number,
    hostUsageBytes?: number,
    hostLimitBytes?: number,
  ): void {
    this.peakTreeRssBytes = Math.max(this.peakTreeRssBytes, treeRssBytes);
    this.memoryUsage.record(
      treeRssBytes,
      this.metricAttributes({ "memory.scope": "process_tree" }),
      this.runContext,
    );
    if (hostUsageBytes !== undefined) {
      this.peakHostUsageBytes = Math.max(
        this.peakHostUsageBytes,
        hostUsageBytes,
      );
      this.memoryUsage.record(
        hostUsageBytes,
        this.metricAttributes({ "memory.scope": "service_cgroup" }),
        this.runContext,
      );
    }
    if (hostLimitBytes !== undefined) {
      this.runSpan.setAttribute("memory.cgroup.limit_bytes", hostLimitBytes);
    }
  }

  private recordMilestone(name: "first_event" | "first_text"): void {
    const elapsedMs = this.now() - this.startedAt;
    const attributes = this.metricAttributes({ "compadre.milestone": name });
    this.runSpan.addEvent(name, { elapsed_ms: elapsedMs });
    this.milestoneDuration.record(elapsedMs, attributes, this.runContext);
  }

  end(error?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    const finishedAt = this.now();
    const failure = error ?? this.terminalError;
    if (!this.firstEventObserved) {
      this.firstEventSpan.setAttribute("compadre.milestone.reached", false);
      this.firstEventSpan.end(finishedAt);
    }
    if (!this.firstTextObserved) {
      this.firstTextSpan.setAttribute("compadre.milestone.reached", false);
      this.firstTextSpan.end(finishedAt);
    }
    if (failure !== undefined) {
      this.runSpan.recordException(
        failure instanceof Error ? failure : String(failure),
      );
      this.runSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: errorMessage(failure),
      });
    } else {
      this.runSpan.setStatus({ code: SpanStatusCode.OK });
    }
    const output = this.assistantMessages.terminalText();
    if (output.length > 0) {
      const outputMessages = genAiMessagesAttribute(
        "assistant",
        output,
        this.redactContent,
      );
      this.runSpan.setAttribute("gen_ai.output.messages", outputMessages);
      this.runSpan.setAttribute("langfuse.observation.output", outputMessages);
      this.runSpan.setAttribute("langfuse.trace.output", outputMessages);
    }
    this.runSpan.setAttribute(
      "compadre.agent.duration_ms",
      finishedAt - this.startedAt,
    );
    if (this.peakTreeRssBytes > 0) {
      this.runSpan.setAttribute(
        "memory.process_tree.peak_rss_bytes",
        this.peakTreeRssBytes,
      );
    }
    if (this.peakHostUsageBytes > 0) {
      this.runSpan.setAttribute(
        "memory.cgroup.peak_usage_bytes",
        this.peakHostUsageBytes,
      );
    }
    this.runDuration.record(
      finishedAt - this.startedAt,
      this.metricAttributes({
        "compadre.outcome": failure === undefined ? "success" : "error",
      }),
      this.runContext,
    );
    this.runSpan.end(finishedAt);
  }
}
