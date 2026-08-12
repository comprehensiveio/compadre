import { task } from "@renderinc/sdk/workflows";
import {
  executeAgentWorkflow,
  executeRepositoryProbe,
  type AgentWorkflowResult,
  type RepositoryProbeResult,
} from "./agent-run.js";
import {
  executeDurabilityProbe,
  type DurabilityProbeResult,
} from "./durability-probe.js";
import { withWorkflowTelemetry } from "./telemetry.js";

const NO_RETRIES = {
  maxRetries: 0,
  waitDurationMs: 1_000,
  backoffScaling: 1,
} as const;

/** Cheap task used to measure Workflow spin-up and repository acquisition. */
export const probeAgentRuntime = task(
  {
    name: "probeAgentRuntime",
    plan: "starter",
    timeoutSeconds: 300,
    retry: NO_RETRIES,
  },
  async function probeAgentRuntime(): Promise<RepositoryProbeResult> {
    return withWorkflowTelemetry("probeAgentRuntime", () =>
      executeRepositoryProbe(),
    );
  },
);

/** One isolated TanStack AI coding-agent turn on a 4 GB Workflow instance. */
export const runAgent = task(
  {
    name: "runAgent",
    plan: "pro",
    timeoutSeconds: 30 * 60,
    // Side effects are not idempotent yet. Reliability requires failing once
    // rather than silently duplicating Slack messages, commits, or pull requests.
    retry: NO_RETRIES,
  },
  async function runAgent(input: unknown): Promise<AgentWorkflowResult> {
    return withWorkflowTelemetry("runAgent", () =>
      executeAgentWorkflow(input),
    );
  },
);

/** Internal diagnostic that proves a completed AG-UI run can be replayed. */
export const probeAgentDurability = task(
  {
    name: "probeAgentDurability",
    plan: "starter",
    timeoutSeconds: 300,
    retry: NO_RETRIES,
  },
  async function probeAgentDurability(
    input: unknown,
  ): Promise<DurabilityProbeResult> {
    return withWorkflowTelemetry("probeAgentDurability", () =>
      executeDurabilityProbe(input),
    );
  },
);
