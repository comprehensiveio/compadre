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
  type TokenUsage,
} from "@tanstack/ai";
import {
  otelMiddleware,
  type OtelSpanInfo,
} from "@tanstack/ai/middlewares/otel";
import type { HarnessSelection } from "./harness.js";
import { sessionIdFromChunk } from "./protocol.js";
import {
  TELEMETRY_MAX_CONTENT_LENGTH,
  appendTelemetryContent,
  createTelemetryContentRedactor,
  genAiMessagesAttribute,
  serializeTelemetryValue,
} from "./telemetry-content.js";

interface HarnessToolRun {
  id: string;
  name: string;
  startedAt: number;
  endedAt?: number;
  input?: string;
  output?: string;
  outcome: "success" | "error" | "unknown";
}

export interface HarnessTelemetryOptions {
  selection: HarnessSelection;
  threadId: string;
  runId: string;
  worktreeId: string;
  tracer?: Tracer;
  meter?: Meter;
  environment?: NodeJS.ProcessEnv;
}

function modelProvider(provider: HarnessSelection["provider"]): string {
  return provider === "codex" ? "openai" : "anthropic";
}

function reportedCost(usage: TokenUsage | undefined): number | undefined {
  if (!usage) return undefined;
  if (typeof usage.cost === "number") return usage.cost;
  const providerCost = usage.providerUsageDetails?.totalCostUsd;
  return typeof providerCost === "number" ? providerCost : undefined;
}

function normalizedUsage(
  usage: TokenUsage,
  provider: HarnessSelection["provider"],
): TokenUsage {
  const cost = reportedCost(usage);
  let normalized = usage;

  if (provider === "claude-code") {
    // Claude reports non-cached, cache-read, and cache-write input separately.
    // Datadog defines input_tokens as their sum; preserving Claude's raw
    // input_tokens here would make Datadog infer a negative non-cached count.
    const cacheRead = usage.promptTokensDetails?.cachedTokens ?? 0;
    const cacheWrite = usage.promptTokensDetails?.cacheWriteTokens ?? 0;
    const promptTokens = usage.promptTokens + cacheRead + cacheWrite;
    normalized = {
      ...usage,
      promptTokens,
      totalTokens: promptTokens + usage.completionTokens,
    };
  }

  if (cost !== undefined && normalized.cost !== cost) {
    normalized = { ...normalized, cost };
  }
  return normalized;
}

function withNormalizedUsage(
  chunk: StreamChunk,
  provider: HarnessSelection["provider"],
): StreamChunk {
  if (chunk.type !== EventType.RUN_FINISHED || !chunk.usage) return chunk;
  const usage = normalizedUsage(chunk.usage, provider);
  return usage === chunk.usage ? chunk : { ...chunk, usage };
}

/**
 * TanStack pipes transformed chunks between onChunk hooks, but onUsage and
 * onFinish each receive the engine's original provider usage. Decorate OTel's
 * lifecycle hooks so a later raw callback cannot overwrite the normalized
 * attributes it observed on RUN_FINISHED.
 */
function withNormalizedTelemetryUsage(
  telemetry: ChatMiddleware,
  provider: HarnessSelection["provider"],
): ChatMiddleware {
  return {
    ...telemetry,
    onUsage(ctx, usage) {
      return telemetry.onUsage?.(ctx, normalizedUsage(usage, provider));
    },
    onFinish(ctx, info) {
      return telemetry.onFinish?.(
        ctx,
        info.usage
          ? { ...info, usage: normalizedUsage(info.usage, provider) }
          : info,
      );
    },
  };
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
  environment = process.env,
}: HarnessTelemetryOptions): [ChatMiddleware, ChatMiddleware] {
  const tools = new Map<string, HarnessToolRun>();
  const redactContent = createTelemetryContentRedactor(environment);
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
      const chunk = withNormalizedUsage(originalChunk, selection.provider);
      sessionId ??= sessionIdFromChunk(chunk, selection.provider);
      totalCostUsd ??=
        chunk.type === EventType.RUN_FINISHED
          ? reportedCost(chunk.usage)
          : undefined;

      if (chunk.type === EventType.TOOL_CALL_START) {
        tools.set(chunk.toolCallId, {
          id: chunk.toolCallId,
          name: chunk.toolCallName,
          startedAt: chunk.timestamp ?? Date.now(),
          outcome: "unknown",
        });
      } else if (chunk.type === EventType.TOOL_CALL_ARGS) {
        const tool = tools.get(chunk.toolCallId);
        if (tool) {
          tool.input = appendTelemetryContent(tool.input, chunk.delta);
        }
      } else if (chunk.type === EventType.TOOL_CALL_END) {
        const tool = tools.get(chunk.toolCallId);
        if (tool && chunk.input !== undefined) {
          tool.input = serializeTelemetryValue(chunk.input);
        }
      } else if (chunk.type === EventType.TOOL_CALL_RESULT) {
        const tool = tools.get(chunk.toolCallId);
        if (tool) {
          tool.endedAt = chunk.timestamp ?? Date.now();
          tool.output = serializeTelemetryValue(chunk.content);
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
      if (tool.input !== undefined) {
        const input = genAiMessagesAttribute("tool", tool.input, redactContent);
        span.setAttribute("gen_ai.input.messages", input);
        span.setAttribute("langfuse.observation.input", input);
      }
      if (tool.output !== undefined) {
        const output = genAiMessagesAttribute(
          "tool",
          tool.output,
          redactContent,
        );
        span.setAttribute("gen_ai.output.messages", output);
        span.setAttribute("langfuse.observation.output", output);
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

  const telemetry = withNormalizedTelemetryUsage(
    otelMiddleware({
      tracer,
      meter,
      captureContent: true,
      redact: redactContent,
      maxContentLength: TELEMETRY_MAX_CONTENT_LENGTH,
      attributeEnricher: enrichSpan,
      onSpanEnd(info, span) {
        span.setAttributes(commonAttributes());
        if (totalCostUsd !== undefined) {
          span.setAttribute("gen_ai.usage.cost", totalCostUsd);
        }
        if (info.kind === "iteration") emitHarnessToolSpans(span);
      },
    }),
    selection.provider,
  );

  return [harnessEvents, telemetry];
}
