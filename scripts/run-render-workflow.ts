import dotenv from "dotenv";
import crypto from "node:crypto";
import { Render } from "@renderinc/sdk";
import { waitForTaskRun } from "../src/render-workflows.js";

dotenv.config({ path: ".env.local", quiet: true });

const taskName = process.argv[2];
if (taskName !== "probeAgentRuntime" && taskName !== "runAgent") {
  throw new Error(
    "usage: run-render-workflow.ts probeAgentRuntime | runAgent [prompt]",
  );
}

const workflowSlug =
  process.env.COMPADRE_RENDER_WORKFLOW_SLUG ?? "compadre-agent";
const taskSlug = `${workflowSlug}/${taskName}`;
const useLocalDev = process.env.RENDER_USE_LOCAL_DEV === "true";
const render = new Render({ useLocalDev });
const input =
  taskName === "probeAgentRuntime"
    ? []
    : [
        {
          runId: crypto.randomUUID(),
          prompt:
            process.argv.slice(3).join(" ").trim() ||
            "Reply with only: hi",
          maxTurns: 1,
        },
      ];

const startedAt = Date.now();
const run = await render.workflows.startTask(taskSlug, input);
console.log(
  JSON.stringify({
    event: "workflow.started",
    taskSlug,
    taskRunId: run.taskRunId,
    runId: taskName === "runAgent" ? input[0]?.runId : undefined,
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

if (result.status !== "completed" && result.status !== "succeeded") {
  process.exitCode = 1;
}
