import { Hono } from "hono";
import {
  latestDevBackup,
  verifyDevBackupAccessToken,
  type LatestDevBackup,
} from "../t3/dev-backups.js";

export interface DevBackupRouteDependencies {
  environment: NodeJS.ProcessEnv;
  latestBackup: () => Promise<LatestDevBackup | null>;
  nowSeconds: () => number;
}

const defaultDependencies: DevBackupRouteDependencies = {
  environment: process.env,
  latestBackup: () => latestDevBackup(process.env),
  nowSeconds: () => Math.floor(Date.now() / 1_000),
};

export function createDevBackupRoutes(
  dependencies: Partial<DevBackupRouteDependencies> = {},
): Hono {
  const deps = { ...defaultDependencies, ...dependencies };
  const routes = new Hono();

  routes.get("/internal/dev-backups/:canonicalThreadId/latest", async (c) => {
    const canonicalThreadId = c.req.param("canonicalThreadId");
    const secret = deps.environment.COMPADRE_DEV_BACKUP_ACCESS_SECRET?.trim();
    const authorization = c.req.header("authorization");
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    if (
      !secret ||
      !verifyDevBackupAccessToken({
        token,
        canonicalThreadId,
        secret,
        nowSeconds: deps.nowSeconds(),
      })
    ) {
      return c.json({ ok: false, error: "Unauthorized" }, 401);
    }
    try {
      const backup = await deps.latestBackup();
      if (!backup) {
        return c.json({ ok: false, error: "No development backup found" }, 404);
      }
      c.header("cache-control", "no-store");
      return c.json({
        ok: true,
        canonicalThreadId,
        backup,
      });
    } catch (error) {
      console.warn("[dev-backups] latest backup unavailable", {
        canonicalThreadId,
        kind: error instanceof Error ? error.constructor.name : "unknown",
      });
      return c.json(
        { ok: false, error: "Development backup unavailable" },
        503,
      );
    }
  });

  return routes;
}

export const devBackupRoutes = createDevBackupRoutes();
