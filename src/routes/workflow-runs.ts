import crypto from "node:crypto";
import {
  isTerminalRunStatus,
  resumeServerSentEventsResponse,
  type StreamDurability,
} from "@tanstack/ai";
import { Hono } from "hono";
import { z } from "zod";
import { agentWorkflowInputSchema } from "../workflows/agent-run.js";
import {
  failOpenDurableRun,
  getConfiguredAgentRunDurability,
  type AgentRunDurability,
} from "../durability/runtime.js";
import {
  createConfiguredWorkflowRunLauncher,
  type WorkflowRunLauncher,
} from "../services/workflow-run-launcher.js";
import { requireCompadreApiKey } from "./auth.js";

const workflowRunInputSchema = agentWorkflowInputSchema.omit({
  responseMode: true,
  slackFiles: true,
});

export interface WorkflowRunRouteDependencies {
  enabled(): boolean;
  getDurability(): Promise<AgentRunDurability | null>;
  getLauncher(): WorkflowRunLauncher;
  createId(): string;
}

let configuredLauncher: WorkflowRunLauncher | undefined;
const defaultDependencies: WorkflowRunRouteDependencies = {
  enabled: () => process.env.COMPADRE_WORKFLOW_RELAY_ENABLED === "true",
  getDurability: getConfiguredAgentRunDurability,
  getLauncher: () =>
    (configuredLauncher ??= createConfiguredWorkflowRunLauncher()),
  createId: () => crypto.randomUUID(),
};

function resumableAdapter(
  stream: StreamDurability<string>,
  request: Request,
): StreamDurability<string> {
  const offset =
    request.headers.get("Last-Event-ID") ||
    new URL(request.url).searchParams.get("offset");
  return {
    resumeFrom: () => offset,
    append: (chunks) => stream.append(chunks),
    read: (streamOffset, signal) => stream.read(streamOffset, signal),
    close: () => stream.close(),
    snapshot: () => stream.snapshot(),
  };
}

export function createWorkflowRunRoutes(
  dependencies: WorkflowRunRouteDependencies = defaultDependencies,
): Hono {
  const routes = new Hono();

  routes.post("/workflow-runs", async (c) => {
    if (!dependencies.enabled()) return c.notFound();
    const authError = requireCompadreApiKey(c);
    if (authError) return authError;

    let input: z.infer<typeof workflowRunInputSchema>;
    try {
      input = workflowRunInputSchema.parse(await c.req.json());
    } catch (error) {
      return c.json(
        {
          error: "invalid workflow run input",
          detail: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }

    const durability = await dependencies.getDurability();
    if (!durability) {
      return c.json({ error: "agent run durability is not configured" }, 503);
    }
    const runId = input.runId ?? dependencies.createId();
    const threadId = input.threadId ?? `workflow-${runId}`;
    // Resolve the stream before launching so a local in-process producer and
    // relay are guaranteed to share the same memory adapter instance.
    durability.stream(runId);
    await durability.runs.createOrResume({
      runId,
      threadId,
      startedAt: Date.now(),
    });
    const launcher = dependencies.getLauncher();
    let started: Awaited<ReturnType<WorkflowRunLauncher["start"]>>;
    try {
      started = await launcher.start({
        ...input,
        runId,
        threadId,
      });
    } catch (error) {
      try {
        await failOpenDurableRun(durability, runId, error);
      } catch (finalizationError) {
        console.error("[workflow-route] failure finalization failed", {
          runId,
          error: finalizationError,
        });
      }
      throw error;
    }
    if (launcher.wait) {
      void launcher.wait(started.taskRunId).catch(async (error) => {
        try {
          await failOpenDurableRun(durability, runId, error);
        } catch (finalizationError) {
          console.error("[workflow-route] failure finalization failed", {
            runId,
            error: finalizationError,
          });
        }
      });
    }
    return c.json(
      {
        runId,
        threadId,
        taskRunId: started.taskRunId,
        eventsUrl: `/workflow-runs/${encodeURIComponent(runId)}/events?offset=-1`,
      },
      202,
    );
  });

  routes.get("/workflow-runs/:runId/events", async (c) => {
    if (!dependencies.enabled()) return c.notFound();
    const authError = requireCompadreApiKey(c);
    if (authError) return authError;
    const durability = await dependencies.getDurability();
    if (!durability) {
      return c.json({ error: "agent run durability is not configured" }, 503);
    }
    const adapter = resumableAdapter(
      durability.stream(c.req.param("runId")),
      c.req.raw,
    );
    return resumeServerSentEventsResponse({
      adapter,
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  routes.get("/workflow-runs/:runId", async (c) => {
    if (!dependencies.enabled()) return c.notFound();
    const authError = requireCompadreApiKey(c);
    if (authError) return authError;
    const durability = await dependencies.getDurability();
    if (!durability) {
      return c.json({ error: "agent run durability is not configured" }, 503);
    }
    const run = await durability.runs.get(c.req.param("runId"));
    return run ? c.json(run) : c.json({ error: "run not found" }, 404);
  });

  routes.post("/workflow-runs/:runId/cancel", async (c) => {
    if (!dependencies.enabled()) return c.notFound();
    const authError = requireCompadreApiKey(c);
    if (authError) return authError;
    const durability = await dependencies.getDurability();
    if (!durability) {
      return c.json({ error: "agent run durability is not configured" }, 503);
    }
    const runId = c.req.param("runId");
    const run = await durability.runs.get(runId);
    if (!run) return c.json({ error: "run not found" }, 404);
    if (isTerminalRunStatus(run.status)) {
      return c.json({ ok: true, cancelled: false, status: run.status });
    }
    const cancelRun = dependencies.getLauncher().cancelRun;
    if (!cancelRun) {
      return c.json({ error: "workflow cancellation is not supported" }, 501);
    }
    const cancelled = await cancelRun(runId);
    if (!cancelled) {
      return c.json(
        { error: "run is not active on this controller", runId },
        409,
      );
    }
    return c.json({ ok: true, cancelled: true, status: "cancelling" }, 202);
  });

  return routes;
}

export const workflowRunRoutes = createWorkflowRunRoutes();
