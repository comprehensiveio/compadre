import { Hono, type Context, type Handler } from "hono";
import { getConfiguredAgentRunDurability } from "../durability/runtime.js";
import { getConfiguredThreadPersistence } from "../persistence/runtime.js";
import { buildT3ThreadOperationsSnapshot } from "../services/t3-thread-operations.js";
import { getConfiguredT3Gateway } from "../t3/runtime.js";
import {
  clearWorkerTemplate,
  readWorkerTemplate,
  type T3WorkerTemplate,
} from "../t3/worker-templates.js";
import type { MetadataStore } from "../t3/storage.js";
import { requireCompadreApiKey } from "./auth.js";

export interface T3OperationsRoutesDependencies {
  enabled(): boolean;
  snapshot(): Promise<unknown>;
  metadata?(): Promise<MetadataStore | null>;
  startTemplateBuild?(): Promise<string>;
}

const defaultDependencies: T3OperationsRoutesDependencies = {
  enabled: () => process.env.COMPADRE_T3_DIRECTORY_ENABLED === "true",
  async metadata() {
    const runtime = await getConfiguredThreadPersistence();
    return runtime?.persistence.stores.metadata ?? null;
  },
  async startTemplateBuild() {
    const { getTemporalClient } = await import("../temporal/client.js");
    const { NATIVE_T3_TASK_QUEUE } = await import("../temporal/shared.js");
    const client = await getTemporalClient();
    const handle = await client.workflow.start("t3WorkerTemplateBuildWorkflow", {
      workflowId: `t3-worker-template-build-manual-${Date.now()}`,
      taskQueue: NATIVE_T3_TASK_QUEUE,
    });
    return handle.workflowId;
  },
  async snapshot() {
    const [gateway, durability] = await Promise.all([
      getConfiguredT3Gateway(),
      getConfiguredAgentRunDurability(),
    ]);
    if (!gateway || !durability) {
      throw new Error("T3 operations require the configured gateway and durability");
    }
    return buildT3ThreadOperationsSnapshot({
      bindings: await gateway.list(),
      durability,
    });
  },
};

function guarded(handler: (c: Context) => Promise<Response>): Handler {
  return async (c) => {
    try {
      return await handler(c);
    } catch (error) {
      console.error("[t3-operations] snapshot failed", {
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "T3 operations snapshot failed" }, 502);
    }
  };
}

export function createT3OperationsRoutes(
  dependencies: T3OperationsRoutesDependencies = defaultDependencies,
): Hono {
  const routes = new Hono();
  routes.get(
    "/internal/operations/threads",
    guarded(async (c) => {
      if (!dependencies.enabled()) return c.notFound();
      const authError = requireCompadreApiKey(c);
      if (authError) return authError;
      return c.json(await dependencies.snapshot(), 200, {
        "cache-control": "no-store",
      });
    }),
  );
  routes.get(
    "/internal/operations/worker-template",
    guarded(async (c) => {
      if (!dependencies.enabled()) return c.notFound();
      const authError = requireCompadreApiKey(c);
      if (authError) return authError;
      const metadata = await dependencies.metadata?.();
      if (!metadata) return c.json({ error: "persistence unavailable" }, 502);
      const template: T3WorkerTemplate | null = await readWorkerTemplate(metadata);
      return c.json({ template }, 200, { "cache-control": "no-store" });
    }),
  );
  // Deleting the pointer is the template kill switch: provisioning falls back
  // to a cold build until the next successful cron build republishes.
  routes.delete(
    "/internal/operations/worker-template",
    guarded(async (c) => {
      if (!dependencies.enabled()) return c.notFound();
      const authError = requireCompadreApiKey(c);
      if (authError) return authError;
      const metadata = await dependencies.metadata?.();
      if (!metadata) return c.json({ error: "persistence unavailable" }, 502);
      await clearWorkerTemplate(metadata);
      return c.json({ cleared: true });
    }),
  );
  routes.post(
    "/internal/operations/worker-template/build",
    guarded(async (c) => {
      if (!dependencies.enabled()) return c.notFound();
      const authError = requireCompadreApiKey(c);
      if (authError) return authError;
      if (!dependencies.startTemplateBuild) {
        return c.json({ error: "builds unavailable" }, 502);
      }
      const workflowId = await dependencies.startTemplateBuild();
      return c.json({ started: workflowId }, 202);
    }),
  );
  return routes;
}

export const t3OperationsRoutes = createT3OperationsRoutes();
