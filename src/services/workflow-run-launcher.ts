import crypto from "node:crypto";
import type { AgentWorkflowInput } from "../workflows/agent-run.js";
import { executeAgentWorkflow } from "../workflows/agent-run.js";

export interface StartedWorkflowRun {
  taskRunId: string;
}

export interface WorkflowRunLauncher {
  start(input: AgentWorkflowInput): Promise<StartedWorkflowRun>;
  wait?(taskRunId: string, signal?: AbortSignal): Promise<void>;
}

/**
 * The persistent relay starts the controller in-process. The controller keeps
 * durability, MCP clients, and private-network access on Render; its harness
 * process runs in Daytona.
 */
export function createLocalWorkflowRunLauncher(
  execute: typeof executeAgentWorkflow = executeAgentWorkflow,
): WorkflowRunLauncher {
  const completions = new Map<string, Promise<void>>();
  return {
    async start(input) {
      const taskRunId = `local-${crypto.randomUUID()}`;
      const completion = new Promise<void>((resolve, reject) => {
        setImmediate(() => {
          void execute(input).then(() => resolve(), reject);
        });
      });
      // Store the original rejection for wait(), while marking it observed when
      // a caller only wants fire-and-tail behavior through the HTTP route.
      void completion.catch(() => undefined);
      completions.set(taskRunId, completion);
      void completion
        .catch(() => undefined)
        .finally(() => completions.delete(taskRunId));
      return { taskRunId };
    },
    async wait(taskRunId) {
      const completion = completions.get(taskRunId);
      if (!completion) throw new Error(`Unknown local Workflow task ${taskRunId}`);
      await completion;
    },
  };
}

export function createConfiguredWorkflowRunLauncher(): WorkflowRunLauncher {
  return createLocalWorkflowRunLauncher();
}
