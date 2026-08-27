import crypto from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { durableRunEventsResponse } from "../durability/http.js";
import {
  apiMessageAttribution,
  startCentralT3DurableRun,
} from "../services/central-t3-run.js";
import {
  configuredCentralT3Client,
  type CentralT3ConversationClient,
} from "../t3/central-conversation.js";
import type { T3Client } from "../t3/client.js";
import { getConfiguredNativeT3RunCoordinator } from "../t3/runtime.js";
import type { NativeT3RunCoordinator } from "../t3/run-coordinator.js";
import { agentWorkflowInputSchema } from "../workflows/agent-run.js";
import { requireCompadreApiKey } from "./auth.js";

const workflowRunInputSchema = agentWorkflowInputSchema.omit({
  responseMode: true,
  slackFiles: true,
});

export interface WorkflowRunRouteDependencies {
  enabled(): boolean;
  getClient():
    | (CentralT3ConversationClient & Pick<T3Client, "interruptTurn">)
    | null;
  getRunCoordinator(): Promise<NativeT3RunCoordinator | null>;
  createId(): string;
}

const defaultDependencies: WorkflowRunRouteDependencies = {
  enabled: () =>
    process.env.COMPADRE_T3_API_ENABLED === "true" ||
    process.env.COMPADRE_WORKFLOW_RELAY_ENABLED === "true",
  getClient: configuredCentralT3Client,
  getRunCoordinator: getConfiguredNativeT3RunCoordinator,
  createId: crypto.randomUUID,
};

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
    if (input.inputFiles && input.inputFiles.length > 0) {
      return c.json(
        {
          error:
            "native T3 workflow attachments are not supported yet; submit a text-only run",
        },
        409,
      );
    }

    const client = dependencies.getClient();
    const coordinator = await dependencies.getRunCoordinator();
    if (!client || !coordinator) {
      return c.json({ error: "central T3 durability is not configured" }, 503);
    }
    const runId = input.runId ?? dependencies.createId();
    const threadId = input.threadId ?? `workflow-${runId}`;
    const profile = input.profile ?? input.provider;
    const started = await startCentralT3DurableRun({
      coordinator,
      client,
      runId,
      threadId,
      title: (input.transcriptUserMessage ?? input.prompt).slice(0, 200),
      prompt: input.prompt,
      displayText: input.transcriptUserMessage ?? input.prompt,
      attribution: apiMessageAttribution(),
      profile,
    });
    return c.json(
      {
        runId,
        threadId,
        taskRunId: `central-t3:${runId}`,
        started: started.started,
        statusUrl: `/workflow-runs/${encodeURIComponent(runId)}`,
        eventsUrl: `/workflow-runs/${encodeURIComponent(runId)}/events?offset=-1`,
      },
      202,
    );
  });

  routes.get("/workflow-runs/:runId/events", async (c) => {
    if (!dependencies.enabled()) return c.notFound();
    const authError = requireCompadreApiKey(c);
    if (authError) return authError;
    const coordinator = await dependencies.getRunCoordinator();
    if (!coordinator) {
      return c.json({ error: "central T3 durability is not configured" }, 503);
    }
    const runId = c.req.param("runId");
    if (!(await coordinator.run(runId))) {
      return c.json({ error: "run not found" }, 404);
    }
    return durableRunEventsResponse(
      coordinator.stream(runId),
      c.req.raw,
    );
  });

  routes.get("/workflow-runs/:runId", async (c) => {
    if (!dependencies.enabled()) return c.notFound();
    const authError = requireCompadreApiKey(c);
    if (authError) return authError;
    const coordinator = await dependencies.getRunCoordinator();
    if (!coordinator) {
      return c.json({ error: "central T3 durability is not configured" }, 503);
    }
    const run = await coordinator.run(c.req.param("runId"));
    return run ? c.json(run) : c.json({ error: "run not found" }, 404);
  });

  routes.post("/workflow-runs/:runId/cancel", async (c) => {
    if (!dependencies.enabled()) return c.notFound();
    const authError = requireCompadreApiKey(c);
    if (authError) return authError;
    const coordinator = await dependencies.getRunCoordinator();
    if (!coordinator) {
      return c.json({ error: "central T3 durability is not configured" }, 503);
    }
    const result = await coordinator.cancel(c.req.param("runId"));
    if (!result.found) return c.json({ error: "run not found" }, 404);
    return c.json(
      {
        ok: true,
        cancelled: result.requested,
        status: result.requested ? "cancelling" : result.status,
        ...result,
      },
      result.requested ? 202 : 200,
    );
  });

  return routes;
}

export const workflowRunRoutes = createWorkflowRunRoutes();
