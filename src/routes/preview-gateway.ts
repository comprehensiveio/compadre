import crypto from "node:crypto";
import { Hono } from "hono";
import { getConfiguredT3Gateway } from "../t3/runtime.js";

interface PreviewTargetGateway {
  previewTarget(input: {
    canonicalThreadId: string;
  }): Promise<{
    binding: { sandboxId: string; t3ThreadId: string };
    url: string;
  } | null>;
}

export interface PreviewGatewayDependencies {
  getGateway: () => Promise<PreviewTargetGateway | null>;
  environment: NodeJS.ProcessEnv;
}

const defaultDependencies: PreviewGatewayDependencies = {
  getGateway: getConfiguredT3Gateway,
  environment: process.env,
};

function bearerMatches(header: string | undefined, expected: string): boolean {
  const actual = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const actualHash = crypto.createHash("sha256").update(actual).digest();
  const expectedHash = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

export function createPreviewGatewayRoutes(
  dependencies: Partial<PreviewGatewayDependencies> = {},
): Hono {
  const deps = { ...defaultDependencies, ...dependencies };
  const routes = new Hono();

  routes.get("/internal/previews/:canonicalThreadId/target", async (c) => {
    const secret = deps.environment.COMPADRE_PREVIEW_GATEWAY_SECRET?.trim();
    if (!secret || !bearerMatches(c.req.header("authorization"), secret)) {
      return c.json({ ok: false, error: "Unauthorized" }, 401);
    }
    const canonicalThreadId = c.req.param("canonicalThreadId");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(canonicalThreadId)) {
      return c.json({ ok: false, error: "Invalid thread id" }, 400);
    }
    const gateway = await deps.getGateway();
    if (!gateway) {
      return c.json({ ok: false, error: "T3 gateway unavailable" }, 503);
    }
    try {
      const target = await gateway.previewTarget({ canonicalThreadId });
      if (!target) return c.json({ ok: false, error: "Thread not found" }, 404);
      c.header("cache-control", "no-store");
      return c.json({
        ok: true,
        canonicalThreadId,
        t3ThreadId: target.binding.t3ThreadId,
        sandboxId: target.binding.sandboxId,
        targetUrl: target.url,
      });
    } catch (error) {
      console.warn("[preview-gateway] target unavailable", {
        canonicalThreadId,
        kind: error instanceof Error ? error.constructor.name : "unknown",
      });
      return c.json({ ok: false, error: "Preview unavailable" }, 503);
    }
  });

  return routes;
}

export const previewGatewayRoutes = createPreviewGatewayRoutes();
