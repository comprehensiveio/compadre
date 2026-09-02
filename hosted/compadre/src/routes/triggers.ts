import { Hono, type Context, type Handler } from "hono";
import { ZodError } from "zod";
import { log, serializeError } from "../logging.js";
import {
  deleteTriggerSchedule,
  runTriggerNow,
  syncTriggerSchedule,
} from "../triggers/schedule-sync.js";
import {
  getConfiguredTriggeredPromptStore,
  type TriggeredPromptStoreApi,
} from "../triggers/store.js";
import {
  triggeredPromptInputSchema,
  type TriggeredPromptRecord,
} from "../triggers/types.js";
import { requireCompadreApiKey } from "./auth.js";

export interface TriggeredPromptRoutesDependencies {
  enabled(): boolean;
  getStore(): Promise<TriggeredPromptStoreApi | null>;
  sync: {
    syncTriggerSchedule(record: TriggeredPromptRecord): Promise<void>;
    deleteTriggerSchedule(triggerId: string): Promise<void>;
    runTriggerNow(triggerId: string): Promise<string>;
  };
}

const defaultDependencies: TriggeredPromptRoutesDependencies = {
  enabled: () => process.env.COMPADRE_T3_DIRECTORY_ENABLED === "true",
  getStore: getConfiguredTriggeredPromptStore,
  sync: { syncTriggerSchedule, deleteTriggerSchedule, runTriggerNow },
};

function guarded(
  dependencies: TriggeredPromptRoutesDependencies,
  handler: (c: Context, store: TriggeredPromptStoreApi) => Promise<Response>,
): Handler {
  return async (c) => {
    if (!dependencies.enabled()) return c.notFound();
    const authError = requireCompadreApiKey(c);
    if (authError) return authError;
    try {
      const store = await dependencies.getStore();
      if (!store) {
        return c.json(
          { error: "Triggered prompts require Postgres persistence" },
          503,
        );
      }
      return await handler(c, store);
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json(
          {
            error: "Invalid input",
            issues: error.issues.map(
              (issue) => `${issue.path.join(".")}: ${issue.message}`,
            ),
          },
          400,
        );
      }
      log.error(
        { httpPath: c.req.path, ...serializeError(error) },
        "triggered prompt route error",
      );
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  };
}

export function createTriggeredPromptRoutes(
  dependencies: TriggeredPromptRoutesDependencies = defaultDependencies,
): Hono {
  const routes = new Hono();

  routes.get(
    "/triggers/api/prompts",
    guarded(dependencies, async (c, store) =>
      c.json({ prompts: await store.list() }, 200, {
        "cache-control": "no-store",
      }),
    ),
  );

  routes.post(
    "/triggers/api/prompts",
    guarded(dependencies, async (c, store) => {
      const input = triggeredPromptInputSchema.parse(await c.req.json());
      const record = await store.create(input);
      try {
        await dependencies.sync.syncTriggerSchedule(record);
      } catch (error) {
        // Keep DB and Temporal consistent: no schedule, no row.
        await store.delete(record.id);
        throw error;
      }
      return c.json({ prompt: record }, 201);
    }),
  );

  routes.post(
    "/triggers/api/prompts/:id",
    guarded(dependencies, async (c, store) => {
      const input = triggeredPromptInputSchema.parse(await c.req.json());
      const record = await store.update((c.req.param("id") ?? ""), input);
      if (!record) return c.json({ error: "Triggered prompt not found" }, 404);
      await dependencies.sync.syncTriggerSchedule(record);
      return c.json({ prompt: record });
    }),
  );

  routes.post(
    "/triggers/api/prompts/:id/enable",
    guarded(dependencies, async (c, store) => {
      const body = (await c.req.json()) as { enabled?: unknown };
      if (typeof body.enabled !== "boolean") {
        return c.json({ error: "enabled must be a boolean" }, 400);
      }
      const record = await store.setEnabled((c.req.param("id") ?? ""), body.enabled);
      if (!record) return c.json({ error: "Triggered prompt not found" }, 404);
      await dependencies.sync.syncTriggerSchedule(record);
      return c.json({ prompt: record });
    }),
  );

  routes.post(
    "/triggers/api/prompts/:id/delete",
    guarded(dependencies, async (c, store) => {
      const id = (c.req.param("id") ?? "");
      const deleted = await store.delete(id);
      if (!deleted) return c.json({ error: "Triggered prompt not found" }, 404);
      await dependencies.sync.deleteTriggerSchedule(id);
      return c.json({ deleted: true });
    }),
  );

  routes.post(
    "/triggers/api/prompts/:id/run",
    guarded(dependencies, async (c, store) => {
      const record = await store.get((c.req.param("id") ?? ""));
      if (!record) return c.json({ error: "Triggered prompt not found" }, 404);
      const workflowId = await dependencies.sync.runTriggerNow(record.id);
      return c.json({ workflowId }, 202);
    }),
  );

  return routes;
}

export const triggerRoutes = createTriggeredPromptRoutes();
