import { httpHeaderRedactionLayer } from "@t3tools/shared/httpObservability";
import {
  makeLocalFileTracer,
  makeTraceSink,
  otlpSerializationLayer,
} from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";
import * as OtlpExporter from "effect/unstable/observability/OtlpExporter";
import * as OtlpMetrics from "effect/unstable/observability/OtlpMetrics";
import * as OtlpTracer from "effect/unstable/observability/OtlpTracer";

import * as ServerConfig from "../../config.ts";
import * as ResourceAttribution from "../../resourceTelemetry/ResourceAttribution.ts";
import { ServerLoggerLive } from "../../serverLogger.ts";
import * as BrowserTraceCollector from "../BrowserTraceCollector.ts";

function parseOtlpHeaders(value: string | undefined): Record<string, string> {
  if (!value?.trim()) return {};
  return Object.fromEntries(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .flatMap((entry) => {
        const separator = entry.indexOf("=");
        if (separator <= 0) return [];
        const name = entry.slice(0, separator).trim();
        const encodedValue = entry.slice(separator + 1).trim();
        if (!name || !encodedValue) return [];
        try {
          return [[name, decodeURIComponent(encodedValue)]] as const;
        } catch {
          return [[name, encodedValue]] as const;
        }
      }),
  );
}

function isDatadogOtlpEndpoint(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().includes("datadoghq");
  } catch {
    return false;
  }
}

export function otlpTraceHeaders(
  url: string,
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const headers = parseOtlpHeaders(environment.OTEL_EXPORTER_OTLP_TRACES_HEADERS);
  const apiKey = environment.DD_API_KEY?.trim();
  if (!apiKey || !isDatadogOtlpEndpoint(url)) return headers;
  return {
    ...headers,
    "dd-api-key": apiKey,
    "dd-ml-app": environment.DD_LLMOBS_ML_APP?.trim() || "compadre-t3-experiment",
    "dd-otlp-source": "llmobs",
    compute_stats: "true",
  };
}

export const ObservabilityLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;

    const traces = config.otlpTracesExport;
    const metrics = config.otlpMetricsExport;
    // The trace serializer stays in the returned context because the browser
    // trace forwarder exports on the same signal.
    const serializationLayer = otlpSerializationLayer(traces.protocol);
    const resource = ServerConfig.otlpResource(config);
    const attribution = yield* ResourceAttribution.ResourceAttribution;

    const traceReferencesLayer = Layer.mergeAll(
      Layer.succeed(Tracer.MinimumTraceLevel, config.traceMinLevel),
      Layer.succeed(References.TracerTimingEnabled, config.traceTimingEnabled),
      httpHeaderRedactionLayer,
    );

    const tracerLayer = Layer.unwrap(
      Effect.gen(function* () {
        const sink = yield* makeTraceSink({
          filePath: config.serverTracePath,
          maxBytes: config.traceMaxBytes,
          maxFiles: config.traceMaxFiles,
          batchWindowMs: config.traceBatchWindowMs,
          onFlush: (stats) =>
            attribution.record({
              component: "server-trace",
              operation: "append",
              logicalWriteBytes: stats.logicalWriteBytes,
              count: stats.count,
              durationMs: stats.durationMs,
            }),
        });
        const delegate =
          config.otlpTracesUrl === undefined
            ? undefined
            : yield* OtlpTracer.make({
                url: config.otlpTracesUrl,
                exportInterval: `${traces.exportIntervalMs} millis`,
                headers: { ...traces.headers, ...otlpTraceHeaders(config.otlpTracesUrl) },
                resource,
              });

        const tracer = yield* makeLocalFileTracer({
          filePath: config.serverTracePath,
          maxBytes: config.traceMaxBytes,
          maxFiles: config.traceMaxFiles,
          batchWindowMs: config.traceBatchWindowMs,
          sink,
          ...(delegate ? { delegate } : {}),
        });

        return Layer.mergeAll(
          Layer.succeed(Tracer.Tracer, tracer),
          BrowserTraceCollector.layer(sink),
        );
      }),
    ).pipe(Layer.provide(OtlpExporter.layerFlusher), Layer.provideMerge(serializationLayer));

    const metricsLayer =
      config.otlpMetricsUrl === undefined
        ? Layer.empty
        : OtlpMetrics.layer({
            url: config.otlpMetricsUrl,
            exportInterval: `${metrics.exportIntervalMs} millis`,
            headers: metrics.headers,
            resource,
          }).pipe(Layer.provide(otlpSerializationLayer(metrics.protocol)));

    // Logged once the server's loggers are installed, so the warnings use them.
    const otelWarningsLayer = Layer.effectDiscard(
      Effect.forEach(config.otelEnvironment.warnings, (warning) => Effect.logWarning(warning)),
    );

    return otelWarningsLayer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(ServerLoggerLive, traceReferencesLayer, tracerLayer, metricsLayer),
      ),
      Layer.provide(
        OtelEnvironment.layerResourceAttributes(config.otelEnvironment.resourceAttributes),
      ),
    );
  }),
);
