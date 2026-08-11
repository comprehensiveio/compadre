import assert from "node:assert/strict";
import test from "node:test";
import { EventType } from "@tanstack/ai";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { HarnessRunTelemetry } from "./runtime-telemetry.js";

test("keeps startup phases under one coarse agent trace", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer("compadre-runtime-test");
  let now = 1_000;
  const telemetry = new HarnessRunTelemetry({
    selection: { provider: "claude-code", model: "claude-opus-5" },
    threadId: "thread-1",
    runId: "run-1",
    tracer,
    now: () => now,
  });

  await telemetry.phase("queue.thread", async () => {
    now = 1_012;
  });
  telemetry.setWorktree("worktree-1", "on-demand");
  now = 1_020;
  telemetry.observe({
    type: EventType.RUN_STARTED,
    threadId: "thread-1",
    runId: "run-1",
    timestamp: now,
  });
  now = 1_030;
  telemetry.observe({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: "message-1",
    delta: "hello",
    timestamp: now,
  });
  telemetry.observeMemory(1_024, 2_048, 4_096);
  now = 1_040;
  telemetry.end();

  const spans = exporter.getFinishedSpans();
  const root = spans.find((span) => span.name === "compadre.agent.run");
  const queue = spans.find(
    (span) => span.name === "compadre.agent.queue.thread",
  );
  const firstEvent = spans.find(
    (span) => span.name === "compadre.agent.wait.first_event",
  );
  const firstText = spans.find(
    (span) => span.name === "compadre.agent.wait.first_text",
  );
  assert.ok(root);
  assert.ok(queue);
  assert.ok(firstEvent);
  assert.ok(firstText);
  assert.equal(queue.parentSpanContext?.spanId, root.spanContext().spanId);
  assert.equal(firstEvent.parentSpanContext?.spanId, root.spanContext().spanId);
  assert.equal(firstText.parentSpanContext?.spanId, root.spanContext().spanId);
  assert.equal(firstEvent.attributes["compadre.milestone.reached"], true);
  assert.equal(firstText.attributes["compadre.milestone.reached"], true);
  assert.equal(root.attributes["worktree.source"], "on-demand");
  assert.equal(root.attributes["compadre.agent.duration_ms"], 40);
  assert.equal(root.attributes["memory.process_tree.peak_rss_bytes"], 1_024);
  assert.equal(root.attributes["memory.cgroup.peak_usage_bytes"], 2_048);
  assert.equal(root.attributes["memory.cgroup.limit_bytes"], 4_096);
  assert.deepEqual(
    root.events.map((event) => [event.name, event.attributes?.elapsed_ms]),
    [
      ["first_event", 20],
      ["first_text", 30],
    ],
  );

  await provider.shutdown();
});

test("marks the agent run and failing phase as errors", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const telemetry = new HarnessRunTelemetry({
    selection: { provider: "codex", model: "gpt-5.6-sol" },
    threadId: "thread-error",
    runId: "run-error",
    tracer: provider.getTracer("compadre-runtime-error-test"),
  });
  const failure = new Error("capacity unavailable");

  await assert.rejects(
    telemetry.phase("queue.capacity", async () => {
      throw failure;
    }),
    failure,
  );
  telemetry.end(failure);

  const spans = exporter.getFinishedSpans();
  const root = spans.find((span) => span.name === "compadre.agent.run");
  const capacity = spans.find(
    (span) => span.name === "compadre.agent.queue.capacity",
  );
  assert.ok(root);
  assert.ok(capacity);
  assert.equal(root.status.code, 2);
  assert.equal(capacity.status.code, 2);

  await provider.shutdown();
});
