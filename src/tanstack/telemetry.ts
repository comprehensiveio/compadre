import {
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  metrics,
  trace as otelTrace,
  type AttributeValue,
  type Meter,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import {
  EventType,
  type ChatMiddleware,
  type StreamChunk,
} from "@tanstack/ai";
import {
  otelMiddleware,
  type OtelSpanInfo,
} from "@tanstack/ai/middlewares/otel";
import type { HarnessSelection } from "./harness.js";
import { sessionIdFromChunk } from "./protocol.js";

interface HarnessToolRun {
  id: string;
  name: string;
  startedAt: number;
  endedAt?: number;
  outcome: "success" | "error" | "unknown";
}

export interface HarnessTelemetryOptions {
  selection: HarnessSelection;
  threadId: string;
  runId: string;
  worktreeId: string;
  tracer?: Tracer;
  meter?: Meter;
}

function modelProvider(provider: HarnessSelection["provider"]): string {
  return provider === "codex" ? "openai" : "anthropic";
}

function reportedCost(chunk: StreamChunk): number | undefined {
  if (chunk.type !== EventType.RUN_FINISHED || !chunk.usage) return undefined;
  if (typeof chunk.usage.cost === "number") return chunk.usage.cost;
  const providerCost = chunk.usage.providerUsageDetails?.totalCostUsd;
  return typeof providerCost === "number" ? providerCost : undefined;
}

function withNormalizedCost(chunk: StreamChunk): StreamChunk {
  const cost = reportedCost(chunk);
  if (
    cost === undefined ||
    chunk.type !== EventType.RUN_FINISHED ||
    !chunk.usage ||
    chunk.usage.cost === cost
  ) {
    return chunk;
  }
  return { ...chunk, usage: { ...chunk.usage, cost } };
}

/**
 * Build telemetry at the TanStack lifecycle boundary. The first middleware
 * normalizes harness events; the second is TanStack's vendor-neutral OTel
 * implementation. Keep this ordering so OTel observes normalized usage.
 */
export function createHarnessTelemetryMiddleware({
  selection,
  threadId,
  runId,
  worktreeId,
  tracer = otelTrace.getTracer("compadre.tanstack-ai"),
  meter = metrics.getMeter("compadre.tanstack-ai"),
}: HarnessTelemetryOptions): [ChatMiddleware, ChatMiddleware] {
  const tools = new Map<string, HarnessToolRun>();
  let sessionId: string | undefined;
  let totalCostUsd: number | undefined;
  let toolSpansEmitted = false;

  const commonAttributes = (): Record<string, AttributeValue> => ({
    "gen_ai.conversation.id": threadId,
    "agui.thread_id": threadId,
    "agui.run_id": runId,
    "worktree.id": worktreeId,
    "agent.provider": selection.provider,
    "gen_ai.provider.name": modelProvider(selection.provider),
    ...(sessionId ? { "agent.session_id": sessionId } : {}),
  });

  const harnessEvents: ChatMiddleware = {
    name: "compadre-harness-events",
    onChunk(_ctx, originalChunk) {
      const chunk = withNormalizedCost(originalChunk);
      sessionId ??= sessionIdFromChunk(chunk, selection.provider);
      totalCostUsd ??= reportedCost(chunk);

      if (chunk.type === EventType.TOOL_CALL_START) {
        tools.set(chunk.toolCallId, {
          id: chunk.toolCallId,
          name: chunk.toolCallName,
          startedAt: chunk.timestamp ?? Date.now(),
          outcome: "unknown",
        });
      } else if (chunk.type === EventType.TOOL_CALL_RESULT) {
        const tool = tools.get(chunk.toolCallId);
        if (tool) {
          tool.endedAt = chunk.timestamp ?? Date.now();
          tool.outcome = chunk.state === "output-error" ? "error" : "success";
        }
      } else if (
        chunk.type === EventType.RUN_FINISHED ||
        chunk.type === EventType.RUN_ERROR
      ) {
        for (const tool of tools.values()) {
          tool.endedAt ??= chunk.timestamp ?? Date.now();
          if (chunk.type === EventType.RUN_ERROR) tool.outcome = "error";
        }
      }

      return chunk === originalChunk ? undefined : chunk;
    },
  };

  const emitHarnessToolSpans = (parent: Span): void => {
    if (toolSpansEmitted) return;
    toolSpansEmitted = true;
    const parentContext = otelTrace.setSpan(otelContext.active(), parent);

    for (const tool of tools.values()) {
      const span = tracer.startSpan(
        `execute_tool ${tool.name}`,
        {
          kind: SpanKind.INTERNAL,
          startTime: tool.startedAt,
          attributes: {
            ...commonAttributes(),
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": tool.name,
            "gen_ai.tool.call.id": tool.id,
            "gen_ai.tool.type": "function",
            "tanstack.ai.tool.outcome": tool.outcome,
          },
        },
        parentContext
      );
      if (tool.outcome === "error") {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      span.end(tool.endedAt ?? Date.now());
    }
  };

  const enrichSpan = (info: OtelSpanInfo): Record<string, AttributeValue> => ({
    ...commonAttributes(),
    ...(info.kind === "chat"
      ? { "gen_ai.operation.name": "invoke_agent" }
      : {}),
  });

  const telemetry = otelMiddleware({
    tracer,
    meter,
    captureContent: false,
    attributeEnricher: enrichSpan,
    onSpanEnd(info, span) {
      span.setAttributes(commonAttributes());
      if (totalCostUsd !== undefined) {
        span.setAttribute("gen_ai.usage.cost", totalCostUsd);
      }
      if (info.kind === "iteration") emitHarnessToolSpans(span);
    },
  });

  return [harnessEvents, telemetry];
}
