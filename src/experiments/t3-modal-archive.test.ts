import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveT3ForkArchive } from "./t3-modal.js";

test("prefers a local T3 fork path without downloading", async () => {
  assert.equal(
    await resolveT3ForkArchive({ COMPADRE_T3_PACKAGE_PATH: "/tmp/local.tgz" }),
    "/tmp/local.tgz",
  );
});

test("downloads and verifies a pinned T3 fork archive", async () => {
  const bytes = new TextEncoder().encode("compiled T3 fork");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "compadre-t3-archive-"));
  let fetches = 0;
  const environment = {
    COMPADRE_T3_PACKAGE_URL: "https://releases.example/t3.tgz",
    COMPADRE_T3_PACKAGE_SHA256: digest,
  };
  const options = {
    cacheDirectory: directory,
    fetch: async () => {
      fetches += 1;
      return new Response(bytes, { status: 200 });
    },
  };

  const first = await resolveT3ForkArchive(environment, options);
  const second = await resolveT3ForkArchive(environment, options);
  assert.equal(first, second);
  assert.deepEqual(new Uint8Array(await fs.readFile(first!)), bytes);
  assert.equal(fetches, 1);
});

test("rejects a T3 fork archive whose digest differs", async () => {
  await assert.rejects(
    resolveT3ForkArchive(
      {
        COMPADRE_T3_PACKAGE_URL: "https://releases.example/t3.tgz",
        COMPADRE_T3_PACKAGE_SHA256: "0".repeat(64),
      },
      {
        cacheDirectory: await fs.mkdtemp(path.join(os.tmpdir(), "compadre-t3-archive-")),
        fetch: async () => new Response("wrong archive", { status: 200 }),
      },
    ),
    /does not match/,
  );
});
