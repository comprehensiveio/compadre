import assert from "node:assert/strict";
import test from "node:test";
import { createPreviewGatewayRoutes } from "./preview-gateway.js";

const threadId = "e160a306-b842-57ba-a8f2-04de157e5366";
const binding = {
  canonicalThreadId: threadId,
  providerInstanceId: "codex",
  sandboxId: "sb-existing",
  projectId: "project-1",
  t3ThreadId: "t3-thread",
  baseUrl: "https://t3.example",
  modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
  status: "ready" as const,
  createdAt: "2026-08-30T12:00:00.000Z",
  updatedAt: "2026-08-30T12:00:00.000Z",
};

test("preview target endpoint is service authenticated", async () => {
  const routes = createPreviewGatewayRoutes({
    environment: { COMPADRE_PREVIEW_GATEWAY_SECRET: "preview-secret" },
    getGateway: async () => null,
  });
  const response = await routes.request(
    `https://controller.example/internal/previews/${threadId}/target`,
  );
  assert.equal(response.status, 401);
});

test("preview target endpoint resolves an existing sandbox", async () => {
  const requested: string[] = [];
  const routes = createPreviewGatewayRoutes({
    environment: { COMPADRE_PREVIEW_GATEWAY_SECRET: "preview-secret" },
    getGateway: async () => ({
      inspectPreview: async ({ canonicalThreadId }) => {
        requested.push(canonicalThreadId);
        return {
          state: "ready" as const,
          binding,
          url: "https://sandbox-3000.modal.host",
        };
      },
    }),
  });
  const response = await routes.request(
    `https://controller.example/internal/previews/${threadId}/target`,
    { headers: { authorization: "Bearer preview-secret" } },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(requested, [threadId]);
  assert.deepEqual(await response.json(), {
    ok: true,
    canonicalThreadId: threadId,
    t3ThreadId: "t3-thread",
    sandboxId: "sb-existing",
    targetUrl: "https://sandbox-3000.modal.host",
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("preview target endpoint does not create missing threads", async () => {
  const routes = createPreviewGatewayRoutes({
    environment: { COMPADRE_PREVIEW_GATEWAY_SECRET: "preview-secret" },
    getGateway: async () => ({ inspectPreview: async () => null }),
  });
  const response = await routes.request(
    `https://controller.example/internal/previews/${threadId}/target`,
    { headers: { authorization: "Bearer preview-secret" } },
  );
  assert.equal(response.status, 404);
});

test("preview target reports restorable idle environments without waking them", async () => {
  const routes = createPreviewGatewayRoutes({
    environment: { COMPADRE_PREVIEW_GATEWAY_SECRET: "preview-secret" },
    getGateway: async () => ({
      inspectPreview: async () => ({
        state: "idle" as const,
        reason: "worker_unavailable" as const,
        binding: { ...binding, workerSnapshotId: "snapshot-1" },
      }),
    }),
    getActivationService: async () => ({
      status: async () => null,
      start: async () => {
        throw new Error("unused");
      },
    }),
  });
  const response = await routes.request(
    `https://controller.example/internal/previews/${threadId}/target`,
    { headers: { authorization: "Bearer preview-secret" } },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: false, state: "idle" });
});

test("preview activation refuses to replace a dead worker without a checkpoint", async () => {
  let starts = 0;
  const routes = createPreviewGatewayRoutes({
    environment: { COMPADRE_PREVIEW_GATEWAY_SECRET: "preview-secret" },
    getGateway: async () => ({
      inspectPreview: async () => ({
        state: "idle" as const,
        reason: "worker_unavailable" as const,
        binding,
      }),
    }),
    getActivationService: async () => ({
      status: async () => null,
      start: async () => {
        starts += 1;
        throw new Error("must not start");
      },
    }),
  });
  const response = await routes.request(
    `https://controller.example/internal/previews/${threadId}/activate`,
    {
      method: "POST",
      headers: { authorization: "Bearer preview-secret" },
    },
  );

  assert.equal(response.status, 410);
  assert.equal(starts, 0);
  assert.deepEqual(await response.json(), {
    ok: false,
    state: "unavailable",
    error: "This preview has no restorable checkpoint.",
  });
});

test("preview status reads an active activation without probing Modal", async () => {
  let inspections = 0;
  const routes = createPreviewGatewayRoutes({
    environment: { COMPADRE_PREVIEW_GATEWAY_SECRET: "preview-secret" },
    getGateway: async () => ({
      inspectPreview: async () => {
        inspections += 1;
        return null;
      },
    }),
    getActivationService: async () => ({
      status: async () => ({
        canonicalThreadId: threadId,
        activationId: "activation-1",
        phase: "restoring" as const,
        updatedAt: "2026-08-30T12:00:00.000Z",
      }),
      start: async () => {
        throw new Error("unused");
      },
    }),
  });
  const response = await routes.request(
    `https://controller.example/internal/previews/${threadId}/target`,
    { headers: { authorization: "Bearer preview-secret" } },
  );

  assert.equal(response.status, 202);
  assert.equal(inspections, 0);
  assert.deepEqual(await response.json(), { ok: false, state: "restoring" });
});

test("preview activation starts one durable workflow and reports its state", async () => {
  const starts: string[] = [];
  const routes = createPreviewGatewayRoutes({
    environment: { COMPADRE_PREVIEW_GATEWAY_SECRET: "preview-secret" },
    getGateway: async () => ({
      inspectPreview: async () => ({
        state: "idle" as const,
        reason: "server_stopped" as const,
        binding,
      }),
    }),
    getActivationService: async () => ({
      status: async () => null,
      start: async (canonicalThreadId) => {
        starts.push(canonicalThreadId);
        return {
          canonicalThreadId,
          activationId: "activation-1",
          phase: "requested" as const,
          updatedAt: "2026-08-30T12:00:00.000Z",
        };
      },
    }),
  });
  const response = await routes.request(
    `https://controller.example/internal/previews/${threadId}/activate`,
    {
      method: "POST",
      headers: { authorization: "Bearer preview-secret" },
    },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(starts, [threadId]);
  assert.deepEqual(await response.json(), { ok: true, state: "requested" });
});
