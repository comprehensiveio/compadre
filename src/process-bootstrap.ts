import path from "node:path";
import dotenv from "dotenv";
import { ensureRuntimeDependencies } from "./runtime.js";

/**
 * Initialize the shared process environment before loading application or
 * workflow modules. Keeping this boundary common prevents the web service and
 * ephemeral workflow workers from silently receiving different telemetry or
 * harness configuration.
 */
export async function initializeCompadreProcess(): Promise<void> {
  dotenv.config({ path: ".env.local" });
  ensureRuntimeDependencies();

  // These defaults must be present before dd-trace initializes. They enable
  // the OpenTelemetry bridge used by TanStack AI while still allowing a
  // deployment to override or explicitly disable each Datadog feature.
  process.env.DD_SERVICE ??= "compadre";
  process.env.DD_LLMOBS_ENABLED ??= "1";
  process.env.DD_LLMOBS_ML_APP ??= "compadre";
  process.env.DD_TRACE_OTEL_ENABLED ??= "true";
  process.env.DD_METRICS_OTEL_ENABLED ??= "true";

  // Initialize tracing before loading application modules so ESM integrations
  // and the provider-neutral TanStack runtime can be instrumented.
  const tracerInitializer = "dd-trace/initialize.mjs";
  await import(tracerInitializer);
  const { registerDatadogOpenTelemetry } = await import("./telemetry.js");
  registerDatadogOpenTelemetry();

  // Ensure nvm-managed Node binaries are available to coding harnesses.
  const nodeDir = path.dirname(process.execPath);
  if (!process.env.PATH?.split(path.delimiter).includes(nodeDir)) {
    process.env.PATH = [nodeDir, process.env.PATH]
      .filter(Boolean)
      .join(path.delimiter);
  }
}
