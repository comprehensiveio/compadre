import assert from "node:assert/strict";
import test from "node:test";
import { createPreviewReadinessRoutes, readyPreviewSnapshot } from "./preview-readiness.js";
import type { ThreadEnvironmentObservation } from "../services/thread-environment-observations.js";

test("only publishes fresh reachable previews, omitting infrastructure details", () => {
  const now = Date.parse("2026-09-07T12:00:00Z");
  const ready: ThreadEnvironmentObservation = {
    container: "running", devServer: "ready", database: "ready",
    previewUrl: "https://thread.dev.example", checkedAt: new Date(now).toISOString(),
  };
  const observations = new Map<string, ThreadEnvironmentObservation>([
    ["ready", ready],
    ["stopped", { ...ready, devServer: "stopped" }],
    ["broken", { ...ready, devServer: "unresponsive" }],
    ["unknown", { ...ready, devServer: "unknown" }],
    ["dead", { ...ready, container: "stopped" }],
    ["stale", { ...ready, checkedAt: new Date(now - 90_000).toISOString() }],
    ["future", { ...ready, checkedAt: new Date(now + 1).toISOString() }],
    ["missing-time", { ...ready, checkedAt: undefined }],
    ["missing-url", { ...ready, previewUrl: undefined }],
  ]);
  assert.deepEqual(readyPreviewSnapshot(observations, now), {
    previews: [{ threadId: "ready", url: ready.previewUrl, checkedAt: ready.checkedAt }],
  });
});

test("readiness route authenticates before reading and handles disabled/error states", async () => {
  const previous = process.env.COMPADRE_API_KEY;
  process.env.COMPADRE_API_KEY = "test-key";
  try {
    let reads = 0;
    let enabled = true;
    let fail = false;
    const routes = createPreviewReadinessRoutes({
      enabled: () => enabled,
      async snapshot() { reads++; if (fail) throw new Error("offline"); return { previews: [] }; },
    });
    const headers = { authorization: "Bearer test-key" };
    assert.equal((await routes.request("/internal/previews/ready")).status, 401);
    assert.equal(reads, 0);
    const response = await routes.request("/internal/previews/ready", { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { previews: [] });
    enabled = false;
    assert.equal((await routes.request("/internal/previews/ready", { headers })).status, 404);
    assert.equal(reads, 1);
    enabled = true; fail = true;
    assert.equal((await routes.request("/internal/previews/ready", { headers })).status, 502);
  } finally {
    if (previous === undefined) delete process.env.COMPADRE_API_KEY;
    else process.env.COMPADRE_API_KEY = previous;
  }
});
