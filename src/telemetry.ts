import ddTrace from "dd-trace";

let openTelemetryRegistered = false;

/** Route OpenTelemetry API instrumentation through the already-configured Datadog tracer. */
export function registerDatadogOpenTelemetry(): void {
  if (openTelemetryRegistered) return;
  const provider = new ddTrace.TracerProvider();
  provider.register();
  openTelemetryRegistered = true;
}
