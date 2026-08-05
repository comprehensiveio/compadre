import assert from "node:assert/strict";
import test from "node:test";
import {
  EventType,
  type ChatMiddleware,
  type ChatMiddlewareContext,
  type StreamChunk,
} from "@tanstack/ai";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createHarnessTelemetryMiddleware } from "./telemetry.js";

function middlewareContext(
  provider: "claude-code" | "codex",
  model: string
): ChatMiddlewareContext {
  return {
    requestId: "request-1",
    streamId: "stream-1",
    runId: "run-1",
    threadId: "thread-1",
    phase: "init",
    iteration: 0,
    chunkIndex: 0,
    abort: () => undefined,
    context: undefined,
    defer: () => undefined,
    activity: "chat",
    provider,
    model,
    source: "server",
    streaming: true,
    systemPrompts: [],
    messageCount: 1,
    hasTools: false,
    currentMessageId: null,
    accumulatedContent: "",
    messages: [{ role: "user", content: "inspect the repository" }],
    createId: (prefix: string) => `${prefix}-1`,
    capabilities: new Map(),
    get: () => {
      throw new Error("unused");
    },
    getOptional: () => undefined,
    provide: () => undefined,
  } as unknown as ChatMiddlewareContext;
}

async function passChunk(
  observer: ChatMiddleware,
  telemetry: ChatMiddleware,
  ctx: ChatMiddlewareContext,
  chunk: StreamChunk
): Promise<StreamChunk> {
  const transformed = await observer.onChunk?.(ctx, chunk);
  const normalized =
    transformed && !Array.isArray(transformed) ? transformed : chunk;
  await telemetry.onChunk?.(ctx, normalized);
  if (normalized.type === EventType.RUN_FINISHED && normalized.usage) {
    await telemetry.onUsage?.(ctx, normalized.usage);
  }
  return normalized;
}

test("emits GenAI spans, harness tool spans, usage, and provider cost", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer("compadre-test");
  const [observer, telemetry] = createHarnessTelemetryMiddleware({
    selection: {
      provider: "claude-code",
      model: "claude-opus-5",
      sessionEvent: "claude-code.session-id",
    },
    threadId: "thread-1",
    runId: "run-1",
    worktreeId: "worktree-1",
    tracer,
  });
  const ctx = middlewareContext("claude-code", "claude-opus-5");
  const config = {
    messages: [{ role: "user" as const, content: "inspect the repository" }],
    systemPrompts: [],
    tools: [],
    modelOptions: {},
  };

  await telemetry.onConfig?.(ctx, config);
  await telemetry.onStart?.(ctx);
  ctx.phase = "beforeModel";
  await telemetry.onConfig?.(ctx, config);

  await passChunk(observer, telemetry, ctx, {
    type: EventType.CUSTOM,
    name: "claude-code.session-id",
    value: { sessionId: "session-1" },
    timestamp: 1_000,
  });
  await passChunk(observer, telemetry, ctx, {
    type: EventType.TOOL_CALL_START,
    toolCallId: "tool-1",
    toolCallName: "Read",
    toolName: "Read",
    timestamp: 1_100,
  });
  await passChunk(observer, telemetry, ctx, {
    type: EventType.TOOL_CALL_RESULT,
    toolCallId: "tool-1",
    messageId: "tool-result-1",
    content: "package.json",
    timestamp: 1_140,
  });
  const finished = await passChunk(observer, telemetry, ctx, {
    type: EventType.RUN_FINISHED,
    runId: "run-1",
    threadId: "thread-1",
    model: "claude-opus-5",
    finishReason: "stop",
    usage: {
      promptTokens: 10,
      completionTokens: 4,
      totalTokens: 14,
      promptTokensDetails: { cachedTokens: 3 },
      providerUsageDetails: { totalCostUsd: 0.12 },
    },
    timestamp: 1_200,
  });
  assert.equal(finished.type, EventType.RUN_FINISHED);
  assert.equal(finished.usage?.cost, 0.12);

  await telemetry.onFinish?.(ctx, {
    finishReason: "stop",
    duration: 200,
    content: "done",
    usage: finished.usage,
  });

  const spans = exporter.getFinishedSpans();
  const root = spans.find((span) => span.name === "chat claude-opus-5");
  const iteration = spans.find(
    (span) => span.name === "chat claude-opus-5 #0"
  );
  const tool = spans.find((span) => span.name === "execute_tool Read");
  assert.ok(root);
  assert.ok(iteration);
  assert.ok(tool);
  assert.equal(root.attributes["gen_ai.operation.name"], "invoke_agent");
  assert.equal(root.attributes["gen_ai.provider.name"], "anthropic");
  assert.equal(root.attributes["gen_ai.conversation.id"], "thread-1");
  assert.equal(root.attributes["agent.session_id"], "session-1");
  assert.equal(root.attributes["agui.thread_id"], "thread-1");
  assert.equal(root.attributes["gen_ai.usage.cost"], 0.12);
  assert.equal(iteration.attributes["gen_ai.usage.input_tokens"], 10);
  assert.equal(iteration.attributes["gen_ai.usage.output_tokens"], 4);
  assert.equal(iteration.attributes["gen_ai.usage.total_tokens"], 14);
  assert.equal(iteration.attributes["gen_ai.usage.cost"], 0.12);
  assert.equal(
    iteration.attributes["gen_ai.usage.cache_read.input_tokens"],
    3
  );
  assert.equal(tool.attributes["gen_ai.operation.name"], "execute_tool");
  assert.equal(tool.attributes["gen_ai.tool.name"], "Read");
  assert.equal(tool.attributes["tanstack.ai.tool.outcome"], "success");
  assert.equal(
    tool.parentSpanContext?.spanId,
    iteration.spanContext().spanId
  );

  await provider.shutdown();
});

test("identifies Codex as OpenAI and records cache and reasoning usage", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const [observer, telemetry] = createHarnessTelemetryMiddleware({
    selection: {
      provider: "codex",
      model: "gpt-5.6-sol",
      sessionEvent: "codex.session-id",
    },
    threadId: "thread-codex",
    runId: "run-codex",
    worktreeId: "worktree-codex",
    tracer: provider.getTracer("compadre-codex-test"),
  });
  const ctx = middlewareContext("codex", "gpt-5.6-sol");
  const config = {
    messages: [{ role: "user" as const, content: "inspect" }],
    systemPrompts: [],
    tools: [],
    modelOptions: {},
  };

  await telemetry.onConfig?.(ctx, config);
  await telemetry.onStart?.(ctx);
  ctx.phase = "beforeModel";
  await telemetry.onConfig?.(ctx, config);
  const finished = await passChunk(observer, telemetry, ctx, {
    type: EventType.RUN_FINISHED,
    runId: "run-codex",
    threadId: "thread-codex",
    model: "gpt-5.6-sol",
    finishReason: "stop",
    usage: {
      promptTokens: 20,
      completionTokens: 7,
      totalTokens: 27,
      promptTokensDetails: { cachedTokens: 11 },
      completionTokensDetails: { reasoningTokens: 5 },
    },
    timestamp: Date.now(),
  });
  await telemetry.onFinish?.(ctx, {
    finishReason: "stop",
    duration: 100,
    content: "done",
    usage: finished.type === EventType.RUN_FINISHED ? finished.usage : undefined,
  });

  const iteration = exporter
    .getFinishedSpans()
    .find((span) => span.name === "chat gpt-5.6-sol #0");
  assert.ok(iteration);
  assert.equal(iteration.attributes["gen_ai.provider.name"], "openai");
  assert.equal(
    iteration.attributes["gen_ai.usage.cache_read.input_tokens"],
    11
  );
  assert.equal(
    iteration.attributes["gen_ai.usage.reasoning.output_tokens"],
    5
  );
  assert.equal(iteration.attributes["gen_ai.usage.cost"], undefined);

  await provider.shutdown();
});
