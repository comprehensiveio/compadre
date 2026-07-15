import dotenv from "dotenv";
import { ensureRuntimeDependencies } from "./runtime.js";

dotenv.config({ path: ".env.local" });
ensureRuntimeDependencies();

// Initialize tracing before loading application modules so ESM integrations,
// including the Claude Agent SDK, can be auto-instrumented.
const tracerInitializer = "dd-trace/initialize.mjs";
await import(tracerInitializer);
await import("./index.js");
