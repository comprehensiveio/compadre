import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  backupCentralT3State,
  configuredCentralT3Backup,
} from "./central-t3-backup.js";

test("configured backup requires its dedicated credential", () => {
  assert.equal(
    configuredCentralT3Backup({
      COMPADRE_T3_CENTRAL_URL: "https://compadre.example",
      COMPADRE_T3_CENTRAL_TOKEN: "session-key",
      COMPADRE_T3_ARTIFACT_BUCKET: "compadre",
    }),
    null,
  );
});

test("verifies and stores an authenticated central T3 SQLite backup", async () => {
  const bytes = new TextEncoder().encode("sqlite-backup");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const uploads: unknown[] = [];
  const result = await backupCentralT3State({
    centralUrl: "https://compadre.example",
    accessToken: "secret",
    now: () => new Date("2026-08-29T21:00:00.000Z"),
    fetchImpl: async (url, init) => {
      assert.equal(
        String(url),
        "https://compadre.example/internal/compadre/state-backup",
      );
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer secret",
      );
      return new Response(bytes, {
        headers: {
          "content-length": String(bytes.byteLength),
          "x-compadre-sha256": sha256,
        },
      });
    },
    objects: {
      async put(input) {
        uploads.push(input);
      },
    },
  });
  assert.deepEqual(result, {
    key: `backups/t3-state/v1/2026/08/29/2026-08-29T21-00-00-000Z-${sha256}.sqlite`,
    sha256,
    sizeBytes: bytes.byteLength,
  });
  assert.equal(uploads.length, 1);
});

test("does not store a backup whose digest header is wrong", async () => {
  let uploaded = false;
  await assert.rejects(
    backupCentralT3State({
      centralUrl: "https://compadre.example",
      accessToken: "secret",
      fetchImpl: async () =>
        new Response("corrupt", {
          headers: { "x-compadre-sha256": "0".repeat(64) },
        }),
      objects: {
        async put() {
          uploaded = true;
        },
      },
    }),
    /SHA-256/,
  );
  assert.equal(uploaded, false);
});
