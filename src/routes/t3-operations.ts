import { Hono, type Context, type Handler } from "hono";
import { getConfiguredAgentRunDurability } from "../durability/runtime.js";
import { buildT3ThreadOperationsSnapshot } from "../services/t3-thread-operations.js";
import { getConfiguredT3Gateway } from "../t3/runtime.js";
import { requireCompadreApiKey } from "./auth.js";

export interface T3OperationsRoutesDependencies {
  enabled(): boolean;
  snapshot(): Promise<unknown>;
}

const defaultDependencies: T3OperationsRoutesDependencies = {
  enabled: () => process.env.COMPADRE_T3_DIRECTORY_ENABLED === "true",
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
  return routes;
}

export const t3OperationsRoutes = createT3OperationsRoutes();
