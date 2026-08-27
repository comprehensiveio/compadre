import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";

import { makeProviderRuntimeTelemetry } from "./ProviderRuntimeTelemetry.ts";

it.effect("records one provider turn with model, usage, cost, and named tool spans", () => {
  const endedSpans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        endedSpans.push(span);
      };
      return span;
    },
  });
  const threadId = ThreadId.make("thread-telemetry");
  const turnId = TurnId.make("turn-telemetry");
  const itemId = RuntimeItemId.make("tool-telemetry");
  const base = {
    eventId: EventId.make("event-telemetry"),
    provider: ProviderDriverKind.make("codex"),
    threadId,
    turnId,
    createdAt: "2026-08-27T00:00:00.000Z",
  } as const;

  return Effect.gen(function* () {
    const telemetry = yield* makeProviderRuntimeTelemetry();
    const turn = yield* telemetry.beginTurn({
      threadId,
      provider: ProviderDriverKind.make("codex"),
      model: "gpt-5.6-sol",
    });
    yield* telemetry.bindTurn(turn, turnId);
    yield* telemetry.observe({
      ...base,
      type: "turn.started",
      payload: { model: "gpt-5.6-sol" },
    } satisfies ProviderRuntimeEvent);
    yield* telemetry.observe({
      ...base,
      type: "thread.token-usage.updated",
      payload: {
        usage: {
          usedTokens: 39,
          lastUsedTokens: 39,
          inputTokens: 30,
          cachedInputTokens: 12,
          outputTokens: 9,
          reasoningOutputTokens: 4,
          lastInputTokens: 30,
          lastCachedInputTokens: 12,
          lastOutputTokens: 9,
          lastReasoningOutputTokens: 4,
        },
      },
    } satisfies ProviderRuntimeEvent);
    yield* telemetry.observe({
      ...base,
      itemId,
      type: "item.started",
      payload: { itemType: "mcp_tool_call", status: "inProgress", title: "render deploy" },
    } satisfies ProviderRuntimeEvent);
    yield* telemetry.observe({
      ...base,
      itemId,
      type: "item.completed",
      payload: { itemType: "mcp_tool_call", status: "completed", title: "render deploy" },
    } satisfies ProviderRuntimeEvent);
    yield* telemetry.observe({
      ...base,
      type: "turn.completed",
      payload: { state: "completed", totalCostUsd: 0.042 },
    } satisfies ProviderRuntimeEvent);

    const providerSpan = endedSpans.find((span) => span.name === "t3.provider.turn");
    const toolSpan = endedSpans.find((span) => span.name === "execute_tool render deploy");
    assert.ok(providerSpan);
    assert.equal(providerSpan.attributes.get("gen_ai.provider.name"), "openai");
    assert.equal(providerSpan.attributes.get("gen_ai.request.model"), "gpt-5.6-sol");
    assert.equal(providerSpan.attributes.get("gen_ai.usage.input_tokens"), 30);
    assert.equal(providerSpan.attributes.get("gen_ai.usage.cache_read.input_tokens"), 12);
    assert.equal(providerSpan.attributes.get("gen_ai.usage.output_tokens"), 9);
    assert.equal(providerSpan.attributes.get("gen_ai.usage.total_tokens"), 39);
    assert.equal(providerSpan.attributes.get("gen_ai.usage.reasoning_tokens"), 4);
    assert.equal(providerSpan.attributes.get("gen_ai.cost.estimated_total"), 0.042);
    assert.equal(providerSpan.sampled, true);
    assert.ok(toolSpan);
    assert.equal(toolSpan.attributes.get("gen_ai.tool.name"), "render deploy");
    assert.equal(toolSpan.parent._tag, "Some");
    if (toolSpan.parent._tag === "Some") {
      assert.equal(toolSpan.parent.value.spanId, providerSpan.spanId);
    }
  }).pipe(Effect.provideService(References.TracerEnabled, false), Effect.withTracer(tracer));
});
