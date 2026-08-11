import {
  SpanKind,
  SpanStatusCode,
  trace,
  type Tracer,
} from "@opentelemetry/api";
import {
  flushDatadogOpenTelemetry,
  recordWorkflowMetrics,
  type WorkflowMetricStatus,
} from "../telemetry.js";

export interface WorkflowTelemetryDependencies {
  tracer?: Tracer;
  flush?: () => Promise<void>;
  now?: () => number;
  recordMetrics?: (
    taskName: string,
    status: WorkflowMetricStatus,
    durationMs: number,
  ) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Trace the complete ephemeral task, including repository preparation. */
export async function withWorkflowTelemetry<T>(
  taskName: string,
  operation: () => Promise<T>,
  dependencies: WorkflowTelemetryDependencies = {},
): Promise<T> {
  const tracer = dependencies.tracer ?? trace.getTracer("compadre.workflow");
  const flush = dependencies.flush ?? flushDatadogOpenTelemetry;
  const now = dependencies.now ?? Date.now;
  const recordMetrics = dependencies.recordMetrics ?? recordWorkflowMetrics;
  const startedAt = now();
  let metricStatus: WorkflowMetricStatus = "success";

  try {
    return await tracer.startActiveSpan(
      "compadre.workflow.run",
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "workflow.system": "render",
          "workflow.task.name": taskName,
        },
      },
      async (span) => {
        try {
          const result = await operation();
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          metricStatus = "error";
          span.recordException(error instanceof Error ? error : String(error));
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: errorMessage(error),
          });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  } finally {
    try {
      recordMetrics(taskName, metricStatus, now() - startedAt);
    } catch (error) {
      console.warn("[telemetry] Workflow metrics failed", error);
    }
    await flush();
  }
}
