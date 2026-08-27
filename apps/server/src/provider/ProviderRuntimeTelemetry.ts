import {
  isToolLifecycleItemType,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Tracer from "effect/Tracer";

export interface TrackedProviderTurn {
  readonly threadId: ThreadId;
  readonly provider: ProviderDriverKind;
  readonly span: Tracer.Span;
  readonly tools: Map<string, Tracer.Span>;
  turnId?: TurnId;
  ended: boolean;
}

export interface ProviderRuntimeTelemetry {
  readonly beginTurn: (input: {
    readonly threadId: ThreadId;
    readonly provider: ProviderDriverKind;
    readonly model?: string;
  }) => Effect.Effect<TrackedProviderTurn>;
  readonly bindTurn: (turn: TrackedProviderTurn, turnId: TurnId) => Effect.Effect<void>;
  readonly failTurn: (turn: TrackedProviderTurn, error: unknown) => Effect.Effect<void>;
  readonly observe: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
}

const turnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;

function toolName(
  event: Extract<ProviderRuntimeEvent, { type: "item.started" | "item.completed" }>,
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

export const makeProviderRuntimeTelemetry = Effect.fn("makeProviderRuntimeTelemetry")(
  function* (): Effect.fn.Return<ProviderRuntimeTelemetry> {
    const pendingByThread = new Map<ThreadId, TrackedProviderTurn>();
    const activeByThread = new Map<ThreadId, TrackedProviderTurn>();
    const activeByTurn = new Map<string, TrackedProviderTurn>();

    const finishTool = Effect.fn("ProviderRuntimeTelemetry.finishTool")(function* (
      turn: TrackedProviderTurn,
      itemId: string,
      failed: boolean,
    ) {
      const span = turn.tools.get(itemId);
      if (!span) return;
      turn.tools.delete(itemId);
      span.attribute("tool.outcome", failed ? "error" : "success");
      const endedAt = yield* Clock.currentTimeNanos;
      span.end(endedAt, failed ? Exit.fail("Provider tool failed") : Exit.succeed(undefined));
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
      turn.span.end(yield* Clock.currentTimeNanos, exit);
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
          ...(input.model ? { "gen_ai.request.model": input.model } : {}),
          ...(process.env.COMPADRE_CANONICAL_THREAD_ID
            ? { "compadre.canonical_thread_id": process.env.COMPADRE_CANONICAL_THREAD_ID }
            : {}),
        },
      });
      const tracked: TrackedProviderTurn = {
        threadId: input.threadId,
        provider: input.provider,
        span,
        tools: new Map(),
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
            turn.span.attribute("gen_ai.response.model", event.payload.model);
          }
          break;
        }
        case "thread.token-usage.updated": {
          for (const [key, value] of Object.entries(usageAttributes(event.payload.usage))) {
            turn.span.attribute(key, value);
          }
          break;
        }
        case "item.started": {
          if (!event.itemId || !isToolLifecycleItemType(event.payload.itemType)) break;
          const name = toolName(event);
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
          });
          turn.tools.set(event.itemId, span);
          break;
        }
        case "item.completed": {
          if (!event.itemId || !isToolLifecycleItemType(event.payload.itemType)) break;
          const failed = event.payload.status === "declined";
          yield* finishTool(turn, event.itemId, failed);
          break;
        }
        case "turn.completed": {
          if (event.payload.totalCostUsd !== undefined) {
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
