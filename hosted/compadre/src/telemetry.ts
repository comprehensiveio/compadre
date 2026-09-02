import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

let openTelemetryRegistered = false;
let agentlessOpenTelemetryRegistered = false;
let registeredTelemetryMode: DatadogTelemetryMode | undefined;
let datadogAgent:
  | (typeof import("dd-trace"))["default"]
  | undefined;
let openTelemetryProvider:
  | {
      register(): void;
      forceFlush?(): Promise<void>;
    }
  | undefined;

const WORKFLOW_TELEMETRY_DRAIN_MS = 250;

export interface DatadogOpenTelemetryOptions {
  ephemeral?: boolean;
  environment?: NodeJS.ProcessEnv;
}

export type DatadogTelemetryMode = "agent" | "agentless";

export function datadogOtlpTracesEndpoint(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const override =
    environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() ||
    environment.DD_OTLP_TRACES_ENDPOINT?.trim();
  if (override) return override;
  const site = environment.DD_SITE?.trim() || "datadoghq.com";
  return `https://otlp.${site}/v1/traces`;
}

export function datadogTelemetryMode(
  options: DatadogOpenTelemetryOptions = {},
): DatadogTelemetryMode {
  const environment = options.environment ?? process.env;
  const requested = environment.COMPADRE_OTEL_EXPORT_MODE?.trim().toLowerCase();
  if (requested === "agentless" && environment.DD_API_KEY?.trim()) {
    return "agentless";
  }
  if (requested === "agent") return "agent";
  return options.ephemeral && environment.DD_API_KEY?.trim()
    ? "agentless"
    : "agent";
}

function createAgentlessWorkflowProvider(
  environment: NodeJS.ProcessEnv,
  apiKey: string,
): NodeTracerProvider {
  const exporter = new OTLPTraceExporter({
    url: datadogOtlpTracesEndpoint(environment),
    headers: {
      "dd-api-key": apiKey,
      "dd-ml-app": environment.DD_LLMOBS_ML_APP || "compadre",
      "dd-otlp-source": "llmobs",
      compute_stats: "true",
    },
  });
  return new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: environment.DD_SERVICE || "compadre",
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]:
        environment.DD_ENV || "development",
      ...(environment.RENDER_GIT_COMMIT
        ? { [ATTR_SERVICE_VERSION]: environment.RENDER_GIT_COMMIT }
        : {}),
      "workflow.system": "render",
    }),
    spanProcessors: [
      new BatchSpanProcessor(exporter, {
        scheduledDelayMillis: 100,
        exportTimeoutMillis: 5_000,
      }),
    ],
    forceFlushTimeoutMillis: 5_000,
  });
}

/**
 * Persistent services use their nearby Datadog Agent. Ephemeral Render
 * Workflow tasks send OTLP directly because no Agent lives with the task.
 */
export async function registerDatadogOpenTelemetry(
  options: DatadogOpenTelemetryOptions = {},
): Promise<DatadogTelemetryMode> {
  if (openTelemetryRegistered && registeredTelemetryMode) {
    return registeredTelemetryMode;
  }
  const environment = options.environment ?? process.env;
  const apiKey = environment.DD_API_KEY?.trim();
  const mode = datadogTelemetryMode(options);
  let provider:
    | NodeTracerProvider
    | {
        register(): void;
        forceFlush?(): Promise<void>;
      };
  if (mode === "agentless") {
    // Do not load dd-trace in an ephemeral task. Its OpenTelemetry bridge
    // replaces the SDK provider even without initialize.mjs, which makes the
    // direct exporter attempt to flush an Agent-backed provider.
    provider = createAgentlessWorkflowProvider(environment, apiKey as string);
  } else {
    const { default: ddTrace } = await import("dd-trace");
    datadogAgent = ddTrace;
    provider = new ddTrace.TracerProvider() as {
      register(): void;
      forceFlush?(): Promise<void>;
    };
  }
  const registeredProvider = provider as {
    register(): void;
    forceFlush?(): Promise<void>;
  };
  registeredProvider.register();
  openTelemetryProvider = registeredProvider;
  agentlessOpenTelemetryRegistered = mode === "agentless";
  registeredTelemetryMode = mode;
  openTelemetryRegistered = true;
  return mode;
}

export type WorkflowMetricStatus = "success" | "error";

/** Emit unsampled task-level signals suitable for reliability alerts and SLOs. */
export function recordWorkflowMetrics(
  taskName: string,
  status: WorkflowMetricStatus,
  durationMs: number,
): void {
  // The task root span carries the same status and duration in agentless mode.
  // DogStatsD requires a colocated Agent, which Render Workflow tasks lack.
  if (agentlessOpenTelemetryRegistered) return;
  if (!datadogAgent) return;
  const tags = {
    task: taskName,
    status,
  };
  datadogAgent.dogstatsd.increment("compadre.workflow.runs", 1, tags);
  datadogAgent.dogstatsd.distribution(
    "compadre.workflow.duration_ms",
    durationMs,
    tags,
  );
}

/**
 * Flush buffered spans before an ephemeral Workflow process is deprovisioned.
 * Telemetry is observational, so a slow/unavailable exporter must never change
 * the task result.
 */
export async function flushDatadogOpenTelemetry(
  timeoutMs = 2_000,
): Promise<void> {
  const forceFlush = openTelemetryProvider?.forceFlush;
  if (!forceFlush) return;

  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      (async () => {
        // LLMObs uses a separate writer from APM traces. Both public flush
        // methods initiate asynchronous Agent requests but do not await their
        // network callbacks, so keep the ephemeral process alive briefly after
        // asking both writers to drain.
        if (!agentlessOpenTelemetryRegistered && datadogAgent) {
          datadogAgent.llmobs.flush();
          datadogAgent.dogstatsd.flush();
        }
        await forceFlush.call(openTelemetryProvider);
        await new Promise<void>((resolve) =>
          setTimeout(resolve, WORKFLOW_TELEMETRY_DRAIN_MS),
        );
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Datadog flush timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    console.warn("[telemetry] final Datadog flush failed", error);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
