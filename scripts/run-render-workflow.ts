import dotenv from "dotenv";
import crypto from "node:crypto";
import { Render } from "@renderinc/sdk";
import {
  isTaskRunSuccessful,
  waitForTaskRun,
} from "../src/render-workflows.js";

dotenv.config({ path: ".env.local", quiet: true });

const taskName = process.argv[2];
if (
  taskName !== "probeAgentRuntime" &&
  taskName !== "runAgent" &&
  taskName !== "probeAgentDurability"
) {
  throw new Error(
    "usage: run-render-workflow.ts probeAgentRuntime | runAgent [prompt] | probeAgentDurability <runId> [expectedText]",
  );
}

const workflowSlug =
  process.env.COMPADRE_RENDER_WORKFLOW_SLUG ?? "compadre-agent";
const taskSlug = `${workflowSlug}/${taskName}`;
const useLocalDev = process.env.RENDER_USE_LOCAL_DEV === "true";
const render = new Render({ useLocalDev });
const input = (() => {
  if (taskName === "probeAgentRuntime") return [];
  if (taskName === "probeAgentDurability") {
    const runId = process.argv[3]?.trim();
    if (!runId) throw new Error("probeAgentDurability requires a runId");
    return [{ runId, expectedText: process.argv[4] }];
  }
  return [
        {
          runId: crypto.randomUUID(),
          prompt:
            process.argv.slice(3).join(" ").trim() ||
            "Reply with only: hi",
        },
      ];
})();

const startedAt = Date.now();
const run = await render.workflows.startTask(taskSlug, input);
console.log(
  JSON.stringify({
    event: "workflow.started",
    taskSlug,
    taskRunId: run.taskRunId,
    runId: taskName === "probeAgentRuntime" ? undefined : input[0]?.runId,
    local: useLocalDev,
  }),
);

const result = await waitForTaskRun(render.workflows, run.taskRunId);
console.log(
  JSON.stringify({
    event: "workflow.finished",
    taskSlug,
    taskRunId: run.taskRunId,
    status: result.status,
    elapsedMs: Date.now() - startedAt,
    results: result.results,
  }),
);

if (!isTaskRunSuccessful(result.status)) {
  process.exitCode = 1;
}
