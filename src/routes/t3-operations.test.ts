import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { createT3OperationsRoutes } from "./t3-operations.js";

async function withApiKey(run: () => Promise<void>): Promise<void> {
  const previous = process.env.COMPADRE_API_KEY;
  process.env.COMPADRE_API_KEY = "test-key";
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.COMPADRE_API_KEY;
    else process.env.COMPADRE_API_KEY = previous;
  }
}

test("serves a no-store thread operations snapshot to authenticated callers", async () => {
  await withApiKey(async () => {
    const app = new Hono();
    app.route(
      "/",
      createT3OperationsRoutes({
        enabled: () => true,
        async snapshot() {
          return { generatedAt: "2026-08-31T18:00:00.000Z", threads: [] };
        },
      }),
    );
    const unauthorized = await app.request("/internal/operations/threads");
    assert.equal(unauthorized.status, 401);

    const response = await app.request("/internal/operations/threads", {
      headers: { authorization: "Bearer test-key" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      generatedAt: "2026-08-31T18:00:00.000Z",
      threads: [],
    });
  });
});

test("keeps the operations API dark when the hosted directory is disabled", async () => {
  const app = new Hono();
  app.route(
    "/",
    createT3OperationsRoutes({
      enabled: () => false,
      async snapshot() {
        throw new Error("must not run");
      },
    }),
  );
  assert.equal((await app.request("/internal/operations/threads")).status, 404);
});

test("worker-template endpoints read, clear, and trigger builds", async () => {
  await withApiKey(async () => {
  const data = new Map<string, unknown>();
  const metadata = {
    async get(namespace: string, key: string) {
      return data.get(`${namespace}:${key}`) ?? null;
    },
    async set(namespace: string, key: string, value: unknown) {
      data.set(`${namespace}:${key}`, value);
    },
    async delete(namespace: string, key: string) {
      data.delete(`${namespace}:${key}`);
    },
  };
  const app = createT3OperationsRoutes({
    enabled: () => true,
    snapshot: async () => ({}),
    metadata: async () => metadata,
    startTemplateBuild: async () => "workflow-1",
  });
  const headers = { Authorization: `Bearer ${process.env.COMPADRE_API_KEY}` };

  const empty = await app.request("/internal/operations/worker-template", { headers });
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { template: null });

  await metadata.set("compadre.t3.worker-template.v1", "current", {
    snapshotId: "im-1",
    repoSha: "abc",
    backupKey: "hourly/x.sql.gz",
    builtAt: "2026-09-01T00:00:00.000Z",
  });
  const filled = await app.request("/internal/operations/worker-template", { headers });
  assert.equal(((await filled.json()) as { template: { snapshotId: string } }).template.snapshotId, "im-1");

  const build = await app.request("/internal/operations/worker-template/build", {
    method: "POST",
    headers,
  });
  assert.equal(build.status, 202);

  const cleared = await app.request("/internal/operations/worker-template", {
    method: "DELETE",
    headers,
  });
  assert.equal(cleared.status, 200);
  assert.deepEqual(await (await app.request("/internal/operations/worker-template", { headers })).json(), {
    template: null,
  });

  assert.equal(
    (await app.request("/internal/operations/worker-template")).status,
    401,
  );
  });
});
