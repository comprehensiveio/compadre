export const AGENT_EXECUTION_TIMEOUT_MS = 30 * 60 * 1_000;

// Keep the isolated Workflow alive long enough for the agent abort to close
// providers, persist its terminal event, and flush telemetry.
export const AGENT_WORKFLOW_TASK_TIMEOUT_SECONDS = 35 * 60;

// The relay must observe the Workflow's terminal state rather than race its
// platform deadline.
export const AGENT_WORKFLOW_WAIT_TIMEOUT_MS = 36 * 60 * 1_000;
