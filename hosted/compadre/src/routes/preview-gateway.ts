import crypto from "node:crypto";
import { Hono } from "hono";
import type { PreviewActivationRecord } from "../services/preview-activation.js";
import type { T3PreviewInspection } from "../t3/gateway.js";
import {
  getConfiguredPreviewActivationService,
  getConfiguredT3Gateway,
} from "../t3/runtime.js";

interface PreviewTargetGateway {
  inspectPreview(input: {
    canonicalThreadId: string;
  }): Promise<T3PreviewInspection | null>;
}

interface PreviewActivationGateway {
  status(canonicalThreadId: string): Promise<PreviewActivationRecord | null>;
  start(canonicalThreadId: string): Promise<PreviewActivationRecord>;
}

export interface PreviewGatewayDependencies {
  getGateway: () => Promise<PreviewTargetGateway | null>;
  getActivationService: () => Promise<PreviewActivationGateway | null>;
  environment: NodeJS.ProcessEnv;
}

const defaultDependencies: PreviewGatewayDependencies = {
  getGateway: getConfiguredT3Gateway,
  getActivationService: getConfiguredPreviewActivationService,
  environment: process.env,
};

function bearerMatches(header: string | undefined, expected: string): boolean {
  const actual = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const actualHash = crypto.createHash("sha256").update(actual).digest();
  const expectedHash = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

function validThreadId(canonicalThreadId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    canonicalThreadId,
  );
}

export function createPreviewGatewayRoutes(
  dependencies: Partial<PreviewGatewayDependencies> = {},
): Hono {
  const deps = { ...defaultDependencies, ...dependencies };
  const routes = new Hono();
  const authorized = (header: string | undefined) => {
    const secret = deps.environment.COMPADRE_PREVIEW_GATEWAY_SECRET?.trim();
    return Boolean(secret && bearerMatches(header, secret));
  };

  routes.get("/internal/previews/:canonicalThreadId/target", async (c) => {
    if (!authorized(c.req.header("authorization"))) {
      return c.json({ ok: false, error: "Unauthorized" }, 401);
    }
    const canonicalThreadId = c.req.param("canonicalThreadId");
    if (!validThreadId(canonicalThreadId)) {
      return c.json({ ok: false, error: "Invalid thread id" }, 400);
    }
    const gateway = await deps.getGateway();
    if (!gateway) {
      return c.json({ ok: false, error: "T3 gateway unavailable" }, 503);
    }
    try {
      const activationService = await deps.getActivationService();
      const activation = await activationService?.status(canonicalThreadId);
      if (
        activation &&
        ["requested", "restoring", "starting"].includes(activation.phase)
      ) {
        c.header("cache-control", "no-store");
        return c.json({ ok: false, state: activation.phase }, 202);
      }
      const inspection = await gateway.inspectPreview({ canonicalThreadId });
      if (!inspection)
        return c.json({ ok: false, error: "Thread not found" }, 404);
      c.header("cache-control", "no-store");
      if (inspection.state === "idle") {
        if (!activationService) {
          return c.json(
            { ok: false, error: "Preview activation unavailable" },
            503,
          );
        }
        if (
          inspection.reason === "worker_unavailable" &&
          !inspection.binding.workerSnapshotId
        ) {
          return c.json(
            {
              ok: false,
              state: "unavailable",
              error: "This preview has no restorable checkpoint.",
            },
            410,
          );
        }
        return c.json(
          {
            ok: false,
            state:
              activation && activation.phase !== "ready"
                ? activation.phase
                : "idle",
            ...(activation?.error ? { error: activation.error } : {}),
          },
          202,
        );
      }
      return c.json({
        ok: true,
        canonicalThreadId,
        t3ThreadId: inspection.binding.t3ThreadId,
        sandboxId: inspection.binding.sandboxId,
        targetUrl: inspection.url,
      });
    } catch (error) {
      console.warn("[preview-gateway] target unavailable", {
        canonicalThreadId,
        kind: error instanceof Error ? error.constructor.name : "unknown",
      });
      return c.json({ ok: false, error: "Preview unavailable" }, 503);
    }
  });

  routes.post("/internal/previews/:canonicalThreadId/activate", async (c) => {
    if (!authorized(c.req.header("authorization"))) {
      return c.json({ ok: false, error: "Unauthorized" }, 401);
    }
    const canonicalThreadId = c.req.param("canonicalThreadId");
    if (!validThreadId(canonicalThreadId)) {
      return c.json({ ok: false, error: "Invalid thread id" }, 400);
    }
    const gateway = await deps.getGateway();
    const activations = await deps.getActivationService();
    if (!gateway || !activations) {
      return c.json(
        { ok: false, error: "Preview activation unavailable" },
        503,
      );
    }
    const inspection = await gateway.inspectPreview({ canonicalThreadId });
    if (!inspection)
      return c.json({ ok: false, error: "Thread not found" }, 404);
    if (inspection.state === "ready") {
      return c.json({ ok: true, state: "ready" });
    }
    if (
      inspection.reason === "worker_unavailable" &&
      !inspection.binding.workerSnapshotId
    ) {
      return c.json(
        {
          ok: false,
          state: "unavailable",
          error: "This preview has no restorable checkpoint.",
        },
        410,
      );
    }
    const activation = await activations.start(canonicalThreadId);
    c.header("cache-control", "no-store");
    return c.json({ ok: true, state: activation.phase }, 202);
  });

  return routes;
}

export const previewGatewayRoutes = createPreviewGatewayRoutes();
