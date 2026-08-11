import { existsSync } from "node:fs";
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

export function configureEphemeralRepositoryEnvironment(
  { ephemeral = false }: CompadreProcessOptions,
  environment: NodeJS.ProcessEnv = process.env,
  processRoot = process.cwd(),
): void {
  if (!ephemeral) return;

  // Render starts every Workflow task in its own instance. A checkout baked
  // into that instance is therefore already an isolated, disposable worktree;
  // cloning it into /tmp and creating a second git worktree only repeats I/O.
  const repositoryPath = path.resolve(
    processRoot,
    ".workflow-cache",
    "repository",
  );
  if (!existsSync(path.join(repositoryPath, ".git"))) return;

  // The shared environment group also serves the persistent web process and
  // may define its durable REPO_PATH. A Workflow needs its own explicit
  // override because that persistent path is not present in task instances.
  environment.REPO_PATH =
    environment.COMPADRE_WORKFLOW_REPO_PATH ?? repositoryPath;
  environment.COMPADRE_SINGLE_USE_REPOSITORY ??= "true";
}

export function usesAgentlessWorkflowTelemetry(
  { ephemeral = false }: CompadreProcessOptions = {},
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return ephemeral && Boolean(environment.DD_API_KEY?.trim());
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
  configureEphemeralRepositoryEnvironment(options);

  // These defaults must be present before dd-trace initializes. They enable
  // the OpenTelemetry bridge used by TanStack AI while still allowing a
  // deployment to override or explicitly disable each Datadog feature.
  configureTelemetryEnvironment(options);

  // Persistent processes use dd-trace auto-instrumentation with their nearby
  // Agent. An ephemeral Workflow has no Agent and must register only the direct
  // OTLP provider; registering both produces incompatible mixed span objects.
  if (!usesAgentlessWorkflowTelemetry(options)) {
    const tracerInitializer = "dd-trace/initialize.mjs";
    await import(tracerInitializer);
  }
  const { registerDatadogOpenTelemetry } = await import("./telemetry.js");
  const telemetryMode = await registerDatadogOpenTelemetry({
    ephemeral: options.ephemeral,
  });
  if (options.ephemeral) {
    console.info("[telemetry] Workflow provider selected", {
      mode: telemetryMode,
      apiKeyConfigured: Boolean(process.env.DD_API_KEY?.trim()),
    });
  }

  // Ensure nvm-managed Node binaries are available to coding harnesses.
  const nodeDir = path.dirname(process.execPath);
  if (!process.env.PATH?.split(path.delimiter).includes(nodeDir)) {
    process.env.PATH = [nodeDir, process.env.PATH]
      .filter(Boolean)
      .join(path.delimiter);
  }
}
