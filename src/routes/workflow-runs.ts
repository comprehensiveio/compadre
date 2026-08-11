import crypto from "node:crypto";
import {
  resumeServerSentEventsResponse,
  type StreamDurability,
} from "@tanstack/ai";
import { Hono } from "hono";
import { z } from "zod";
import {
  getConfiguredAgentRunDurability,
  type AgentRunDurability,
} from "../durability/runtime.js";
import {
  createConfiguredWorkflowRunLauncher,
  type WorkflowRunLauncher,
} from "../services/workflow-run-launcher.js";
import { requireCompadreApiKey } from "./auth.js";

const workflowRunInputSchema = z.object({
  runId: z.string().trim().min(1).optional(),
  prompt: z.string().trim().min(1),
  transcriptUserMessage: z.string().optional(),
  threadId: z.string().trim().min(1).optional(),
  provider: z.enum(["claude-code", "codex"]).optional(),
  profile: z.enum(["claude-code", "codex", "fable"]).optional(),
  maxTurns: z.number().int().positive().optional(),
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
  return { ...stream, resumeFrom: () => offset };
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
    const started = await dependencies.getLauncher().start({
      ...input,
      runId,
      threadId,
    });
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

  return routes;
}

export const workflowRunRoutes = createWorkflowRunRoutes();
