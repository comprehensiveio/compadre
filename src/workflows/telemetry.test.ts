import assert from "node:assert/strict";
import test from "node:test";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { withWorkflowTelemetry } from "./telemetry.js";

test("flushes a successful Workflow root span after ending it", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  let flushed = false;
  const metrics: unknown[][] = [];

  const result = await withWorkflowTelemetry(
    "runAgent",
    async () => "ok",
    {
      tracer: provider.getTracer("workflow-test"),
      flush: async () => void (flushed = true),
      now: (() => {
        const values = [100, 175];
        return () => values.shift() ?? 175;
      })(),
      recordMetrics: (...args) => void metrics.push(args),
    },
  );

  assert.equal(result, "ok");
  assert.equal(flushed, true);
  const span = exporter.getFinishedSpans()[0];
  assert.equal(span.name, "compadre.workflow.run");
  assert.equal(span.status.code, SpanStatusCode.OK);
  assert.equal(span.attributes["workflow.task.name"], "runAgent");
  assert.deepEqual(metrics, [["runAgent", "success", 75]]);
  await provider.shutdown();
});

test("marks a failed Workflow span and still flushes", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  let flushed = false;
  const metrics: unknown[][] = [];

  await assert.rejects(
    withWorkflowTelemetry(
      "probeAgentRuntime",
      async () => {
        throw new Error("probe failed");
      },
      {
        tracer: provider.getTracer("workflow-error-test"),
        flush: async () => void (flushed = true),
        now: (() => {
          const values = [200, 240];
          return () => values.shift() ?? 240;
        })(),
        recordMetrics: (...args) => void metrics.push(args),
      },
    ),
    /probe failed/,
  );

  assert.equal(flushed, true);
  const span = exporter.getFinishedSpans()[0];
  assert.equal(span.status.code, SpanStatusCode.ERROR);
  assert.match(span.status.message ?? "", /probe failed/);
  assert.deepEqual(metrics, [["probeAgentRuntime", "error", 40]]);
  await provider.shutdown();
});

test("does not let telemetry flush failures replace the operation result", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  const result = await withWorkflowTelemetry(
    "runAgent",
    async () => "completed",
    {
      tracer: provider.getTracer("workflow-flush-test"),
      flush: async () => {
        throw new Error("export unavailable");
      },
      recordMetrics: () => undefined,
    },
  );

  assert.equal(result, "completed");
  await provider.shutdown();
});
