import path from "node:path";
import dotenv from "dotenv";
import { ensureRuntimeDependencies } from "./runtime.js";

export interface CompadreProcessOptions {
  /**
   * Ephemeral processes are deprovisioned as soon as their entrypoint returns,
   * so telemetry must be exported as spans finish instead of on the normal
   * batching interval.
   */
  ephemeral?: boolean;
}

export function configureTelemetryEnvironment(
  { ephemeral = false }: CompadreProcessOptions = {},
  environment: NodeJS.ProcessEnv = process.env,
): void {
  environment.DD_SERVICE ??= "compadre";
  environment.DD_LLMOBS_ENABLED ??= "1";
  environment.DD_LLMOBS_ML_APP ??= "compadre";
  environment.DD_TRACE_OTEL_ENABLED ??= "true";
  environment.DD_METRICS_OTEL_ENABLED ??= "true";

  if (ephemeral) {
    environment.DD_TRACE_FLUSH_INTERVAL ??= "0";
  }
}

/**
 * Initialize the shared process environment before loading application or
 * workflow modules. Keeping this boundary common prevents the web service and
 * ephemeral workflow workers from silently receiving different telemetry or
 * harness configuration.
 */
export async function initializeCompadreProcess(
  options: CompadreProcessOptions = {},
): Promise<void> {
  dotenv.config({ path: ".env.local" });
  ensureRuntimeDependencies();

  // These defaults must be present before dd-trace initializes. They enable
  // the OpenTelemetry bridge used by TanStack AI while still allowing a
  // deployment to override or explicitly disable each Datadog feature.
  configureTelemetryEnvironment(options);

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
