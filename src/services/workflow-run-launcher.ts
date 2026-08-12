import crypto from "node:crypto";
import { Render } from "@renderinc/sdk";
import {
  isTaskRunSuccessful,
  waitForTaskRun,
} from "../render-workflows.js";
import type { AgentWorkflowInput } from "../workflows/agent-run.js";
import { executeAgentWorkflow } from "../workflows/agent-run.js";

export interface StartedWorkflowRun {
  taskRunId: string;
}

export interface WorkflowRunLauncher {
  start(input: AgentWorkflowInput): Promise<StartedWorkflowRun>;
  wait?(taskRunId: string, signal?: AbortSignal): Promise<void>;
}

export interface RenderWorkflowRunLauncherOptions {
  workflowSlug: string;
  render?: Render;
}

export function createRenderWorkflowRunLauncher({
  workflowSlug,
  render = new Render(),
}: RenderWorkflowRunLauncherOptions): WorkflowRunLauncher {
  return {
    async start(input) {
      const run = await render.workflows.startTask(
        `${workflowSlug}/runAgent`,
        [input],
      );
      return { taskRunId: run.taskRunId };
    },
    async wait(taskRunId, signal) {
      const result = await waitForTaskRun(render.workflows, taskRunId, { signal });
      if (!isTaskRunSuccessful(result.status)) {
        throw new Error(
          `Render Workflow task ${taskRunId} ended with status ${result.status}`,
        );
      }
    },
  };
}

/**
 * Database-free local runner. Producer and relay share the process-wide memory
 * durability registry, while the execution boundary otherwise matches Render.
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

export function createConfiguredWorkflowRunLauncher(
  environment: NodeJS.ProcessEnv = process.env,
): WorkflowRunLauncher {
  const mode = environment.COMPADRE_WORKFLOW_RUNNER?.trim() || "local";
  if (mode === "local") return createLocalWorkflowRunLauncher();
  if (mode !== "render") {
    throw new Error(
      `COMPADRE_WORKFLOW_RUNNER must be local or render; received ${mode}`,
    );
  }
  const workflowSlug = environment.COMPADRE_RENDER_WORKFLOW_SLUG?.trim();
  if (!workflowSlug) {
    throw new Error(
      "COMPADRE_RENDER_WORKFLOW_SLUG is required for the Render workflow runner",
    );
  }
  return createRenderWorkflowRunLauncher({ workflowSlug });
}
