import crypto from "node:crypto";
import type { AgentWorkflowInput } from "../workflows/agent-run.js";
import { executeAgentWorkflow } from "../workflows/agent-run.js";

export interface StartedWorkflowRun {
  taskRunId: string;
}

export interface WorkflowRunLauncher {
  start(input: AgentWorkflowInput): Promise<StartedWorkflowRun>;
  wait?(taskRunId: string, signal?: AbortSignal): Promise<void>;
  cancelRun?(runId: string): Promise<boolean>;
}

/**
 * The persistent relay starts the controller in-process. The controller keeps
 * durability, MCP clients, and private-network access on Render; its harness
 * process runs in Modal.
 */
export function createLocalWorkflowRunLauncher(
  execute: typeof executeAgentWorkflow = executeAgentWorkflow,
): WorkflowRunLauncher {
  const completions = new Map<string, Promise<void>>();
  const activeRuns = new Map<
    string,
    { taskRunId: string; abortController: AbortController }
  >();
  return {
    async start(input) {
      const taskRunId = `local-${crypto.randomUUID()}`;
      const runId = input.runId ?? taskRunId;
      const abortController = new AbortController();
      const completion = new Promise<void>((resolve, reject) => {
        setImmediate(() => {
          void execute(input, undefined, abortController.signal).then(
            () => resolve(),
            reject,
          );
        });
      });
      // Store the original rejection for wait(), while marking it observed when
      // a caller only wants fire-and-tail behavior through the HTTP route.
      void completion.catch(() => undefined);
      completions.set(taskRunId, completion);
      activeRuns.set(runId, { taskRunId, abortController });
      void completion
        .catch(() => undefined)
        .finally(() => {
          completions.delete(taskRunId);
          if (activeRuns.get(runId)?.taskRunId === taskRunId) {
            activeRuns.delete(runId);
          }
        });
      return { taskRunId };
    },
    async wait(taskRunId) {
      const completion = completions.get(taskRunId);
      if (!completion) throw new Error(`Unknown local Workflow task ${taskRunId}`);
      await completion;
    },
    async cancelRun(runId) {
      const active = activeRuns.get(runId);
      if (!active) return false;
      active.abortController.abort(new Error(`Run ${runId} was cancelled`));
      return true;
    },
  };
}

export function createConfiguredWorkflowRunLauncher(): WorkflowRunLauncher {
  return createLocalWorkflowRunLauncher();
}
