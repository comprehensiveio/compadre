import { Hono } from "hono";
import { observeThreadEnvironments, type ThreadEnvironmentObservation } from "../services/thread-environment-observations.js";
import { getConfiguredT3Gateway } from "../t3/runtime.js";
import { requireCompadreApiKey } from "./auth.js";

export function readyPreviewSnapshot(observations: ReadonlyMap<string, ThreadEnvironmentObservation>, now = Date.now()) {
  return { previews: [...observations].flatMap(([threadId, observation]) => {
    const age = now - Date.parse(observation.checkedAt ?? "");
    return observation.container === "running" && observation.devServer === "ready" &&
      observation.previewUrl && Number.isFinite(age) && age >= 0 && age < 90_000
      ? [{ threadId, url: observation.previewUrl, checkedAt: observation.checkedAt! }]
      : [];
  }) };
}

export function createPreviewReadinessRoutes(dependencies = {
  enabled: () => process.env.COMPADRE_T3_DIRECTORY_ENABLED === "true",
  async snapshot() {
    const gateway = await getConfiguredT3Gateway();
    if (!gateway) return { previews: [] };
    // Listing and observing existing bindings never provisions or restores a worker.
    return readyPreviewSnapshot(observeThreadEnvironments(await gateway.list()));
  },
}) {
  const routes = new Hono();
  routes.get("/internal/previews/ready", async (c) => {
    if (!dependencies.enabled()) return c.notFound();
    const authError = requireCompadreApiKey(c);
    if (authError) return authError;
    try {
      return c.json(await dependencies.snapshot(), 200, { "cache-control": "no-store" });
    } catch {
      return c.json({ error: "Preview readiness unavailable" }, 502);
    }
  });
  return routes;
}

export const previewReadinessRoutes = createPreviewReadinessRoutes();
