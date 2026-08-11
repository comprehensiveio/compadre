import ddTrace from "dd-trace";

let openTelemetryRegistered = false;
let openTelemetryProvider:
  | {
      register(): void;
      forceFlush?(): Promise<void>;
    }
  | undefined;

/** Route OpenTelemetry API instrumentation through the already-configured Datadog tracer. */
export function registerDatadogOpenTelemetry(): void {
  if (openTelemetryRegistered) return;
  const provider = new ddTrace.TracerProvider() as {
    register(): void;
    forceFlush?(): Promise<void>;
  };
  provider.register();
  openTelemetryProvider = provider;
  openTelemetryRegistered = true;
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
      forceFlush.call(openTelemetryProvider),
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
