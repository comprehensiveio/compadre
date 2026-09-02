import assert from "node:assert/strict";
import test from "node:test";
import { issueDevBackupAccessToken } from "../t3/dev-backups.js";
import { createDevBackupRoutes } from "./dev-backups.js";

const threadId = "e160a306-b842-57ba-a8f2-04de157e5366";
const secret = "controller-only-secret";

test("latest development backup endpoint requires its thread-scoped token", async () => {
  const routes = createDevBackupRoutes({
    environment: { COMPADRE_DEV_BACKUP_ACCESS_SECRET: secret },
    latestBackup: async () => null,
  });
  const response = await routes.request(
    `https://controller.example/internal/dev-backups/${threadId}/latest`,
  );
  assert.equal(response.status, 401);
});

test("returns a fresh read-only backup manifest to its originating thread", async () => {
  const token = issueDevBackupAccessToken({
    canonicalThreadId: threadId,
    secret,
    expiresAtSeconds: 2_000,
  });
  const backup = {
    bucket: "comp-prod-db-backups",
    key: "hourly/db-backup.sql.gz",
    lastModified: "2026-08-30T10:00:00.000Z",
    sizeBytes: 123,
    downloadUrl: "https://signed.example/object",
    expiresAt: "2026-08-30T16:00:00.000Z",
  };
  const routes = createDevBackupRoutes({
    environment: { COMPADRE_DEV_BACKUP_ACCESS_SECRET: secret },
    latestBackup: async () => backup,
    nowSeconds: () => 1_000,
  });
  const response = await routes.request(
    `https://controller.example/internal/dev-backups/${threadId}/latest`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    canonicalThreadId: threadId,
    backup,
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("does not let one sandbox request another thread's backup manifest", async () => {
  const token = issueDevBackupAccessToken({
    canonicalThreadId: threadId,
    secret,
    expiresAtSeconds: 2_000,
  });
  const routes = createDevBackupRoutes({
    environment: { COMPADRE_DEV_BACKUP_ACCESS_SECRET: secret },
    latestBackup: async () => null,
    nowSeconds: () => 1_000,
  });
  const response = await routes.request(
    "https://controller.example/internal/dev-backups/9390d2d9-407b-421b-8048-a287231e4416/latest",
    { headers: { authorization: `Bearer ${token}` } },
  );
  assert.equal(response.status, 401);
});
