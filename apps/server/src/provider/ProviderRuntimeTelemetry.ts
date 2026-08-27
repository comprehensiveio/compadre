import {
  isToolLifecycleItemType,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as References from "effect/References";
import type * as Tracer from "effect/Tracer";

export interface TrackedProviderTurn {
  readonly threadId: ThreadId;
  readonly provider: ProviderDriverKind;
  readonly span: Tracer.Span;
  readonly tools: Map<string, TrackedProviderTool>;
  readonly completedTools: Array<CompletedProviderTool>;
  readonly startedAtNs: bigint;
  readonly llmTraceId: string;
  readonly llmSpanId: string;
  readonly input: string;
  model: string | undefined;
  assistantOutput: string;
  usage: Record<string, number>;
  totalCostUsd?: number;
  turnId?: TurnId;
  ended: boolean;
}

interface TrackedProviderTool {
  readonly span: Tracer.Span;
  readonly name: string;
  readonly llmSpanId: string;
  readonly startedAtNs: bigint;
  input: string | undefined;
  output: string | undefined;
}

interface CompletedProviderTool extends Omit<TrackedProviderTool, "span"> {
  readonly endedAtNs: bigint;
  readonly failed: boolean;
}

export interface ProviderRuntimeTelemetry {
  readonly beginTurn: (input: {
    readonly threadId: ThreadId;
    readonly provider: ProviderDriverKind;
    readonly model?: string;
    readonly input?: string;
  }) => Effect.Effect<TrackedProviderTurn>;
  readonly bindTurn: (turn: TrackedProviderTurn, turnId: TurnId) => Effect.Effect<void>;
  readonly failTurn: (turn: TrackedProviderTurn, error: unknown) => Effect.Effect<void>;
  readonly observe: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
}

const turnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;

function toolName(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >,
) {
  return event.payload.title?.trim() || event.payload.itemType.replaceAll("_", " ");
}

function usageAttributes(
  usage: Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }>["payload"]["usage"],
): Record<string, number> {
  const inputTokens = usage.lastInputTokens ?? usage.inputTokens;
  const cachedInputTokens = usage.lastCachedInputTokens ?? usage.cachedInputTokens;
  const outputTokens = usage.lastOutputTokens ?? usage.outputTokens;
  const reasoningTokens = usage.lastReasoningOutputTokens ?? usage.reasoningOutputTokens;
  const totalTokens =
    inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : (usage.lastUsedTokens ?? usage.usedTokens);
  return {
    ...(inputTokens !== undefined ? { "gen_ai.usage.input_tokens": inputTokens } : {}),
    ...(cachedInputTokens !== undefined
      ? { "gen_ai.usage.cache_read.input_tokens": cachedInputTokens }
      : {}),
    ...(outputTokens !== undefined ? { "gen_ai.usage.output_tokens": outputTokens } : {}),
    ...(totalTokens !== undefined ? { "gen_ai.usage.total_tokens": totalTokens } : {}),
    ...(reasoningTokens !== undefined ? { "gen_ai.usage.reasoning_tokens": reasoningTokens } : {}),
  };
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const MAX_CONTENT_CHARS = 32_000;
const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|secret|token|api[-_]?key)/i;

export function redactTelemetryText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|xox[baprs]|gh[opsu])[-_][A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(
      /\b(api[-_]?key|authorization|cookie|password|secret|token)\s*[:=]\s*([^\s,;}]+)/gi,
      "$1=[REDACTED]",
    )
    .slice(0, MAX_CONTENT_CHARS);
}

function redactTelemetryValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (typeof value === "string") return redactTelemetryText(value);
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => redactTelemetryValue(entry, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([key, entry]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactTelemetryValue(entry, depth + 1),
      ]),
  );
}

export function serializeTelemetryValue(value: unknown): string {
  if (typeof value === "string") return redactTelemetryText(value);
  try {
    return JSON.stringify(redactTelemetryValue(value)).slice(0, MAX_CONTENT_CHARS);
  } catch {
    return redactTelemetryText(String(value));
  }
}

function lifecycleInput(data: unknown, detail?: string): string | undefined {
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const item =
      record.item && typeof record.item === "object"
        ? (record.item as Record<string, unknown>)
        : undefined;
    const value = record.input ?? record.arguments ?? item?.arguments ?? item?.command;
    if (value !== undefined) return serializeTelemetryValue(value);
  }
  return detail ? serializeTelemetryValue(detail) : undefined;
}

function lifecycleOutput(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  const item =
    record.item && typeof record.item === "object"
      ? (record.item as Record<string, unknown>)
      : undefined;
  const value = record.result ?? record.output ?? item?.result ?? item?.output;
  return value === undefined ? undefined : serializeTelemetryValue(value);
}

const randomId = (bytes: number) => NodeCrypto.randomBytes(bytes).toString("hex");

function datadogApiOrigin(site: string): string {
  return `https://api.${site}`;
}

// @effect-diagnostics globalFetch:off - This optional exporter targets Datadog's agentless HTTP intake.
async function submitDatadogAgentTrace(
  turn: TrackedProviderTurn,
  endedAtNs: bigint,
  failed: boolean,
): Promise<void> {
  const apiKey = process.env.DD_API_KEY?.trim();
  if (!apiKey) return;
  const site = process.env.DD_SITE?.trim() || "datadoghq.com";
  const mlApp = process.env.DD_LLMOBS_ML_APP?.trim() || "compadre-t3-experiment";
  const service = process.env.DD_SERVICE?.trim() || "compadre-t3-worker";
  const provider = turn.provider === "codex" ? "openai" : "anthropic";
  const sessionId = process.env.COMPADRE_CANONICAL_THREAD_ID?.trim() || turn.threadId;
  const status = failed ? "error" : "ok";
  const commonMeta = {
    model_name: turn.model,
    model_provider: provider,
    metadata: {
      provider: turn.provider,
      thread_id: turn.threadId,
      turn_id: turn.turnId,
      apm_trace_id: turn.span.traceId,
      apm_span_id: turn.span.spanId,
    },
  };
  const spans = [
    {
      parent_id: "undefined",
      trace_id: turn.llmTraceId,
      span_id: turn.llmSpanId,
      name: "t3.provider.turn",
      meta: {
        kind: "agent",
        input: { value: turn.input },
        output: { value: turn.assistantOutput },
        ...commonMeta,
      },
      metrics: {
        ...(turn.usage["gen_ai.usage.input_tokens"] !== undefined
          ? { input_tokens: turn.usage["gen_ai.usage.input_tokens"] }
          : {}),
        ...(turn.usage["gen_ai.usage.output_tokens"] !== undefined
          ? { output_tokens: turn.usage["gen_ai.usage.output_tokens"] }
          : {}),
        ...(turn.usage["gen_ai.usage.total_tokens"] !== undefined
          ? { total_tokens: turn.usage["gen_ai.usage.total_tokens"] }
          : {}),
        ...(turn.totalCostUsd !== undefined ? { total_cost: turn.totalCostUsd } : {}),
      },
      status,
      start_ns: Number(turn.startedAtNs),
      duration: Number(endedAtNs - turn.startedAtNs),
      _dd: {
        span_id: turn.span.spanId,
        trace_id: turn.span.traceId,
        apm_trace_id: turn.span.traceId,
        sample_rate: 1,
      },
    },
    ...turn.completedTools.map((tool) => ({
      parent_id: turn.llmSpanId,
      trace_id: turn.llmTraceId,
      span_id: tool.llmSpanId,
      name: tool.name,
      meta: {
        kind: "tool",
        input: { value: tool.input ?? "" },
        output: { value: tool.output ?? "" },
        metadata: { tool_name: tool.name },
      },
      status: tool.failed ? "error" : "ok",
      start_ns: Number(tool.startedAtNs),
      duration: Number(tool.endedAtNs - tool.startedAtNs),
    })),
  ];
  const response = await fetch(`${datadogApiOrigin(site)}/api/intake/llm-obs/v1/trace/spans`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "DD-API-KEY": apiKey },
    body: JSON.stringify({
      data: {
        type: "span",
        attributes: {
          ml_app: mlApp,
          session_id: sessionId,
          tags: [
            `service:${service}`,
            `env:${process.env.DD_ENV?.trim() || "development"}`,
            `provider:${turn.provider}`,
          ],
          spans,
        },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Datadog Agent Observability intake returned ${response.status}`);
  }
}

export const makeProviderRuntimeTelemetry = Effect.fn("makeProviderRuntimeTelemetry")(
  function* (): Effect.fn.Return<ProviderRuntimeTelemetry> {
    const pendingByThread = new Map<ThreadId, TrackedProviderTurn>();
    const activeByThread = new Map<ThreadId, TrackedProviderTurn>();
    const activeByTurn = new Map<string, TrackedProviderTurn>();

    const finishTool = Effect.fn("ProviderRuntimeTelemetry.finishTool")(function* (
      turn: TrackedProviderTurn,
      itemId: string,
      failed: boolean,
      payload?: {
        readonly detail?: string | undefined;
        readonly data?: unknown;
      },
    ) {
      const tool = turn.tools.get(itemId);
      if (!tool) return;
      turn.tools.delete(itemId);
      tool.input ??= lifecycleInput(payload?.data, payload?.detail);
      tool.output ??= lifecycleOutput(payload?.data);
      if (tool.input !== undefined) tool.span.attribute("gen_ai.tool.call.arguments", tool.input);
      if (tool.output !== undefined) tool.span.attribute("gen_ai.tool.call.result", tool.output);
      tool.span.attribute("tool.outcome", failed ? "error" : "success");
      const endedAt = yield* Clock.currentTimeNanos;
      tool.span.end(endedAt, failed ? Exit.fail("Provider tool failed") : Exit.succeed(undefined));
      turn.completedTools.push({
        name: tool.name,
        llmSpanId: tool.llmSpanId,
        startedAtNs: tool.startedAtNs,
        input: tool.input,
        output: tool.output,
        endedAtNs: endedAt,
        failed,
      });
    });

    const finishTurn = Effect.fn("ProviderRuntimeTelemetry.finishTurn")(function* (
      turn: TrackedProviderTurn,
      exit: Exit.Exit<unknown, unknown>,
    ) {
      if (turn.ended) return;
      turn.ended = true;
      for (const itemId of [...turn.tools.keys()]) {
        yield* finishTool(turn, itemId, Exit.isFailure(exit));
      }
      pendingByThread.delete(turn.threadId);
      activeByThread.delete(turn.threadId);
      if (turn.turnId) activeByTurn.delete(turnKey(turn.threadId, turn.turnId));
      turn.span.attribute(
        "gen_ai.output.messages",
        // @effect-diagnostics-next-line preferSchemaOverJson:off - OTel defines this attribute as JSON text.
        JSON.stringify([
          { role: "assistant", parts: [{ type: "text", content: turn.assistantOutput }] },
        ]),
      );
      const endedAt = yield* Clock.currentTimeNanos;
      turn.span.end(endedAt, exit);
      yield* Effect.promise(() =>
        submitDatadogAgentTrace(turn, endedAt, Exit.isFailure(exit)),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider-runtime-telemetry.datadog-export-failed", {
            cause: String(cause),
            threadId: turn.threadId,
          }),
        ),
      );
      yield* Effect.logInfo("provider-runtime-telemetry.turn-finished", {
        provider: turn.provider,
        threadId: turn.threadId,
        turnId: turn.turnId ?? "unbound",
        outcome: Exit.isFailure(exit) ? "error" : "success",
      });
    });

    const beginTurn: ProviderRuntimeTelemetry["beginTurn"] = Effect.fn(
      "ProviderRuntimeTelemetry.beginTurn",
    )(function* (input) {
      const modelProvider = input.provider === "codex" ? "openai" : "anthropic";
      const startedAtNs = yield* Clock.currentTimeNanos;
      const prompt = redactTelemetryText(input.input ?? "");
      // Provider dispatch RPCs intentionally disable the general-purpose
      // tracer to avoid recording very chatty protocol traffic. This span is
      // the low-volume semantic boundary we do want, so opt it back in even
      // when the caller's fiber has TracerEnabled=false.
      const span = yield* Effect.makeSpan("t3.provider.turn", {
        kind: "internal",
        level: "Info",
        root: true,
        sampled: true,
        attributes: {
          "provider.kind": input.provider,
          "provider.thread_id": input.threadId,
          "agent.provider": input.provider,
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.conversation.id":
            process.env.COMPADRE_CANONICAL_THREAD_ID?.trim() || input.threadId,
          "gen_ai.provider.name": modelProvider,
          "gen_ai.system": modelProvider,
          dd_llmobs_enabled: false,
          // @effect-diagnostics-next-line preferSchemaOverJson:off - OTel defines this attribute as JSON text.
          "gen_ai.input.messages": JSON.stringify([
            { role: "user", parts: [{ type: "text", content: prompt }] },
          ]),
          ...(input.model ? { "gen_ai.request.model": input.model } : {}),
          ...(process.env.COMPADRE_CANONICAL_THREAD_ID
            ? { "compadre.canonical_thread_id": process.env.COMPADRE_CANONICAL_THREAD_ID }
            : {}),
        },
      }).pipe(Effect.provideService(References.TracerEnabled, true));
      const tracked: TrackedProviderTurn = {
        threadId: input.threadId,
        provider: input.provider,
        span,
        tools: new Map(),
        completedTools: [],
        startedAtNs,
        // Reuse the worker's 128-bit OTel trace ID so Datadog can correlate
        // the direct Agent Observability trace without an SDK-specific bridge.
        llmTraceId: span.traceId,
        llmSpanId: randomId(8),
        input: prompt,
        model: input.model,
        assistantOutput: "",
        usage: {},
        ended: false,
      };
      pendingByThread.set(input.threadId, tracked);
      activeByThread.set(input.threadId, tracked);
      yield* Effect.logInfo("provider-runtime-telemetry.turn-started", {
        provider: input.provider,
        threadId: input.threadId,
        model: input.model ?? "provider-default",
        sampled: span.sampled,
      });
      return tracked;
    });

    const bindTurn: ProviderRuntimeTelemetry["bindTurn"] = Effect.fn(
      "ProviderRuntimeTelemetry.bindTurn",
    )(function* (turn, turnId) {
      if (turn.ended) return;
      turn.turnId = turnId;
      turn.span.attribute("provider.turn_id", turnId);
      activeByTurn.set(turnKey(turn.threadId, turnId), turn);
      pendingByThread.delete(turn.threadId);
    });

    const failTurn: ProviderRuntimeTelemetry["failTurn"] = Effect.fn(
      "ProviderRuntimeTelemetry.failTurn",
    )(function* (turn, error) {
      turn.span.attribute("error.message", errorMessage(error));
      yield* finishTurn(turn, Exit.fail(error));
    });

    const observe: ProviderRuntimeTelemetry["observe"] = Effect.fn(
      "ProviderRuntimeTelemetry.observe",
    )(function* (event) {
      const turn =
        event.turnId !== undefined
          ? (activeByTurn.get(turnKey(event.threadId, event.turnId)) ??
            pendingByThread.get(event.threadId) ??
            activeByThread.get(event.threadId))
          : activeByThread.get(event.threadId);
      if (!turn) return;

      if (event.turnId !== undefined && turn.turnId === undefined) {
        yield* bindTurn(turn, event.turnId);
      }

      switch (event.type) {
        case "turn.started": {
          if (event.payload.model) {
            turn.model = event.payload.model;
            turn.span.attribute("gen_ai.response.model", event.payload.model);
          }
          break;
        }
        case "thread.token-usage.updated": {
          const usage = usageAttributes(event.payload.usage);
          Object.assign(turn.usage, usage);
          for (const [key, value] of Object.entries(usage)) {
            turn.span.attribute(key, value);
          }
          break;
        }
        case "item.started": {
          if (!event.itemId || !isToolLifecycleItemType(event.payload.itemType)) break;
          const name = toolName(event);
          const startedAtNs = yield* Clock.currentTimeNanos;
          const span = yield* Effect.makeSpan(`execute_tool ${name}`, {
            parent: turn.span,
            kind: "internal",
            level: "Info",
            sampled: true,
            attributes: {
              "gen_ai.operation.name": "execute_tool",
              "gen_ai.tool.name": name,
              "gen_ai.tool.call.id": event.itemId,
              "gen_ai.conversation.id":
                process.env.COMPADRE_CANONICAL_THREAD_ID?.trim() || event.threadId,
              "provider.kind": event.provider,
              "provider.thread_id": event.threadId,
              ...(event.turnId ? { "provider.turn_id": event.turnId } : {}),
              "provider.item_type": event.payload.itemType,
            },
          }).pipe(Effect.provideService(References.TracerEnabled, true));
          const input = lifecycleInput(event.payload.data, event.payload.detail);
          if (input !== undefined) span.attribute("gen_ai.tool.call.arguments", input);
          turn.tools.set(event.itemId, {
            span,
            name,
            llmSpanId: randomId(8),
            startedAtNs,
            input,
            output: undefined,
          });
          break;
        }
        case "item.updated": {
          if (!event.itemId || !isToolLifecycleItemType(event.payload.itemType)) break;
          const tool = turn.tools.get(event.itemId);
          if (!tool) break;
          tool.input = lifecycleInput(event.payload.data, event.payload.detail) ?? tool.input;
          tool.output = lifecycleOutput(event.payload.data) ?? tool.output;
          if (tool.input !== undefined) {
            tool.span.attribute("gen_ai.tool.call.arguments", tool.input);
          }
          if (tool.output !== undefined) {
            tool.span.attribute("gen_ai.tool.call.result", tool.output);
          }
          break;
        }
        case "item.completed": {
          if (!event.itemId || !isToolLifecycleItemType(event.payload.itemType)) break;
          const failed = event.payload.status === "declined";
          yield* finishTool(turn, event.itemId, failed, event.payload);
          break;
        }
        case "content.delta": {
          if (event.payload.streamKind === "assistant_text") {
            turn.assistantOutput = redactTelemetryText(turn.assistantOutput + event.payload.delta);
          }
          break;
        }
        case "turn.completed": {
          if (event.payload.totalCostUsd !== undefined) {
            turn.totalCostUsd = event.payload.totalCostUsd;
            turn.span.attribute("gen_ai.cost.estimated_total", event.payload.totalCostUsd);
            turn.span.attribute("cost.total_usd", event.payload.totalCostUsd);
          }
          if (event.payload.errorMessage) {
            turn.span.attribute("error.message", event.payload.errorMessage);
          }
          const failed = event.payload.state === "failed" || Boolean(event.payload.errorMessage);
          yield* finishTurn(
            turn,
            failed
              ? Exit.fail(event.payload.errorMessage ?? "Provider turn failed")
              : Exit.succeed(undefined),
          );
          break;
        }
        case "turn.aborted": {
          turn.span.attribute("error.message", event.payload.reason);
          yield* finishTurn(turn, Exit.fail(event.payload.reason));
          break;
        }
      }
    });

    return { beginTurn, bindTurn, failTurn, observe };
  },
);
