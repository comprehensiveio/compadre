import assert from "node:assert/strict";
import test from "node:test";
import { createPreviewGatewayRoutes } from "./preview-gateway.js";

const threadId = "e160a306-b842-57ba-a8f2-04de157e5366";

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
      previewTarget: async ({ canonicalThreadId }) => {
        requested.push(canonicalThreadId);
        return {
          binding: { sandboxId: "sb-existing", t3ThreadId: "t3-thread" },
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
    getGateway: async () => ({ previewTarget: async () => null }),
  });
  const response = await routes.request(
    `https://controller.example/internal/previews/${threadId}/target`,
    { headers: { authorization: "Bearer preview-secret" } },
  );
  assert.equal(response.status, 404);
});
