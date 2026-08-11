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

  const result = await withWorkflowTelemetry(
    "runAgent",
    async () => "ok",
    {
      tracer: provider.getTracer("workflow-test"),
      flush: async () => void (flushed = true),
    },
  );

  assert.equal(result, "ok");
  assert.equal(flushed, true);
  const span = exporter.getFinishedSpans()[0];
  assert.equal(span.name, "compadre.workflow.run");
  assert.equal(span.status.code, SpanStatusCode.OK);
  assert.equal(span.attributes["workflow.task.name"], "runAgent");
  await provider.shutdown();
});

test("marks a failed Workflow span and still flushes", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  let flushed = false;

  await assert.rejects(
    withWorkflowTelemetry(
      "probeAgentRuntime",
      async () => {
        throw new Error("probe failed");
      },
      {
        tracer: provider.getTracer("workflow-error-test"),
        flush: async () => void (flushed = true),
      },
    ),
    /probe failed/,
  );

  assert.equal(flushed, true);
  const span = exporter.getFinishedSpans()[0];
  assert.equal(span.status.code, SpanStatusCode.ERROR);
  assert.match(span.status.message ?? "", /probe failed/);
  await provider.shutdown();
});
