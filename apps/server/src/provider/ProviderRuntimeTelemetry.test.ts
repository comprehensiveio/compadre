// @effect-diagnostics preferSchemaOverJson:off - This test inspects the HTTP JSON payload boundary.
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
  const intakePayloads: unknown[] = [];
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.DD_API_KEY;
  const originalMlApp = process.env.DD_LLMOBS_ML_APP;
  process.env.DD_API_KEY = "test-key";
  process.env.DD_LLMOBS_ML_APP = "compadre-t3-experiment";
  globalThis.fetch = (async (_input, init) => {
    intakePayloads.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 202 });
  }) as typeof fetch;
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
      input: "Deploy this with token=super-secret-value",
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
      payload: {
        itemType: "mcp_tool_call",
        status: "inProgress",
        title: "render deploy",
        data: { input: { service: "worker", apiKey: "tool-secret" } },
      },
    } satisfies ProviderRuntimeEvent);
    yield* telemetry.observe({
      ...base,
      itemId,
      type: "item.completed",
      payload: {
        itemType: "mcp_tool_call",
        status: "completed",
        title: "render deploy",
        data: { result: { deploymentId: "dep-123" } },
      },
    } satisfies ProviderRuntimeEvent);
    yield* telemetry.observe({
      ...base,
      type: "content.delta",
      payload: { streamKind: "assistant_text", delta: "Deployment completed." },
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
    assert.match(
      String(providerSpan.attributes.get("gen_ai.input.messages")),
      /token=\[REDACTED\]/,
    );
    assert.match(
      String(providerSpan.attributes.get("gen_ai.output.messages")),
      /Deployment completed\./,
    );
    assert.equal(providerSpan.attributes.get("dd_llmobs_enabled"), false);
    assert.equal(providerSpan.sampled, true);
    assert.ok(toolSpan);
    assert.equal(toolSpan.attributes.get("gen_ai.tool.name"), "render deploy");
    assert.match(String(toolSpan.attributes.get("gen_ai.tool.call.arguments")), /\[REDACTED\]/);
    assert.match(String(toolSpan.attributes.get("gen_ai.tool.call.result")), /dep-123/);
    assert.equal(toolSpan.parent._tag, "Some");
    if (toolSpan.parent._tag === "Some") {
      assert.equal(toolSpan.parent.value.spanId, providerSpan.spanId);
    }
    assert.equal(intakePayloads.length, 1);
    const payload = intakePayloads[0] as {
      data: {
        attributes: {
          ml_app: string;
          spans: Array<{
            meta: unknown;
            _dd?: { apm_trace_id?: string };
          }>;
        };
      };
    };
    assert.equal(payload.data.attributes.ml_app, "compadre-t3-experiment");
    assert.equal(payload.data.attributes.spans[0]?._dd?.apm_trace_id, providerSpan.traceId);
    assert.match(JSON.stringify(payload), /Deployment completed\./);
    assert.equal(/super-secret-value|tool-secret/.test(JSON.stringify(payload)), false);
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        globalThis.fetch = originalFetch;
        if (originalApiKey === undefined) delete process.env.DD_API_KEY;
        else process.env.DD_API_KEY = originalApiKey;
        if (originalMlApp === undefined) delete process.env.DD_LLMOBS_ML_APP;
        else process.env.DD_LLMOBS_ML_APP = originalMlApp;
      }),
    ),
    Effect.provideService(References.TracerEnabled, false),
    Effect.withTracer(tracer),
  );
});
