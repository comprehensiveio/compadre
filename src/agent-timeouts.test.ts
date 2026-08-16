import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_EXECUTION_TIMEOUT_MS,
  AGENT_WORKFLOW_TASK_TIMEOUT_SECONDS,
  AGENT_WORKFLOW_WAIT_TIMEOUT_MS,
} from "./agent-timeouts.js";

test("agent, Workflow, and relay timeouts leave ordered cleanup headroom", () => {
  assert.equal(AGENT_EXECUTION_TIMEOUT_MS, 30 * 60 * 1_000);
  assert.equal(AGENT_WORKFLOW_TASK_TIMEOUT_SECONDS, 35 * 60);
  assert.ok(
    AGENT_WORKFLOW_TASK_TIMEOUT_SECONDS * 1_000 >
      AGENT_EXECUTION_TIMEOUT_MS,
  );
  assert.ok(
    AGENT_WORKFLOW_WAIT_TIMEOUT_MS >
      AGENT_WORKFLOW_TASK_TIMEOUT_SECONDS * 1_000,
  );
  assert.equal(AGENT_WORKFLOW_WAIT_TIMEOUT_MS, 36 * 60 * 1_000);
});
