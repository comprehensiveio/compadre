import dotenv from "dotenv";
import { ensureRuntimeDependencies } from "./runtime.js";

dotenv.config({ path: ".env.local" });
ensureRuntimeDependencies();

// These defaults must be present before dd-trace initializes. They enable the
// OpenTelemetry bridge used by TanStack AI while still allowing deployments to
// override or explicitly disable each Datadog feature.
process.env.DD_SERVICE ??= "compadre";
process.env.DD_LLMOBS_ENABLED ??= "1";
process.env.DD_LLMOBS_ML_APP ??= "compadre";
process.env.DD_TRACE_OTEL_ENABLED ??= "true";
process.env.DD_METRICS_OTEL_ENABLED ??= "true";

// Initialize tracing before loading application modules so ESM integrations,
// including the Claude Agent SDK, can be auto-instrumented.
const tracerInitializer = "dd-trace/initialize.mjs";
await import(tracerInitializer);
const { registerDatadogOpenTelemetry } = await import("./telemetry.js");
registerDatadogOpenTelemetry();
await import("./index.js");
