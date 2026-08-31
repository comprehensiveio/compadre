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
