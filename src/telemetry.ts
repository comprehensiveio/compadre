import ddTrace from "dd-trace";

let openTelemetryRegistered = false;
let openTelemetryProvider:
  | {
      register(): void;
      forceFlush?(): Promise<void>;
    }
  | undefined;

const WORKFLOW_TELEMETRY_DRAIN_MS = 250;

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
      (async () => {
        // LLMObs uses a separate writer from APM traces. Both public flush
        // methods initiate asynchronous Agent requests but do not await their
        // network callbacks, so keep the ephemeral process alive briefly after
        // asking both writers to drain.
        ddTrace.llmobs.flush();
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
