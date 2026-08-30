import assert from "node:assert/strict";
import test from "node:test";
import {
  devBackupAccessProjection,
  issueDevBackupAccessToken,
  latestDevBackup,
  verifyDevBackupAccessToken,
} from "./dev-backups.js";

const threadId = "e160a306-b842-57ba-a8f2-04de157e5366";

test("issues thread-scoped expiring access without projecting the signing secret", () => {
  const projection = devBackupAccessProjection(
    {
      COMPADRE_DEV_ENVIRONMENT_ENABLED: "true",
      COMPADRE_DEV_PRODUCTION_DATA_ENABLED: "true",
      COMPADRE_CANONICAL_THREAD_ID: threadId,
      COMPADRE_PUBLIC_URL: "https://controller.example/base",
      COMPADRE_DEV_BACKUP_ACCESS_SECRET: "controller-only-secret",
      COMPADRE_DEV_BACKUP_TOKEN_TTL_SECONDS: "3600",
    },
    () => 1_000_000,
  );
  assert.equal(
    projection.COMPADRE_DEV_BACKUP_MANIFEST_URL,
    `https://controller.example/internal/dev-backups/${threadId}/latest`,
  );
  assert.equal("COMPADRE_DEV_BACKUP_ACCESS_SECRET" in projection, false);
  assert.equal(
    verifyDevBackupAccessToken({
      token: projection.COMPADRE_DEV_BACKUP_TOKEN,
      canonicalThreadId: threadId,
      secret: "controller-only-secret",
      nowSeconds: 1_001,
    }),
    true,
  );
});

test("rejects backup access for another thread or after expiry", () => {
  const token = issueDevBackupAccessToken({
    canonicalThreadId: threadId,
    secret: "secret",
    expiresAtSeconds: 200,
  });
  assert.equal(
    verifyDevBackupAccessToken({
      token,
      canonicalThreadId: "9390d2d9-407b-421b-8048-a287231e4416",
      secret: "secret",
      nowSeconds: 100,
    }),
    false,
  );
  assert.equal(
    verifyDevBackupAccessToken({
      token,
      canonicalThreadId: threadId,
      secret: "secret",
      nowSeconds: 200,
    }),
    false,
  );
});

test("selects and signs the newest configured Comprehensive backup", async () => {
  const signed: Array<Record<string, unknown>> = [];
  const result = await latestDevBackup(
    {
      COMPADRE_DEV_BACKUP_BUCKET: "comp-backups-test",
      COMPADRE_DEV_BACKUP_PREFIX: "hourly/",
      COMPADRE_DEV_BACKUP_REGION: "us-west-2",
      COMPADRE_DEV_BACKUP_DOWNLOAD_TTL_SECONDS: "3600",
    },
    {
      list: async () => [
        {
          key: "hourly/older.sql.gz",
          lastModified: new Date("2026-08-30T09:00:00Z"),
          sizeBytes: 10,
        },
        {
          key: "hourly/latest.sql.gz",
          lastModified: new Date("2026-08-30T10:00:00Z"),
          sizeBytes: 20,
        },
      ],
      sign: async (input) => {
        signed.push(input);
        return "https://signed.example/latest";
      },
      now: () => Date.parse("2026-08-30T10:30:00Z"),
    },
  );
  assert.deepEqual(result, {
    bucket: "comp-backups-test",
    key: "hourly/latest.sql.gz",
    lastModified: "2026-08-30T10:00:00.000Z",
    sizeBytes: 20,
    downloadUrl: "https://signed.example/latest",
    expiresAt: "2026-08-30T11:30:00.000Z",
  });
  assert.deepEqual(signed, [
    {
      bucket: "comp-backups-test",
      key: "hourly/latest.sql.gz",
      region: "us-west-2",
      expiresIn: 3600,
    },
  ]);
});
