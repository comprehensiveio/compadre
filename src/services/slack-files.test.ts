import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  downloadSlackInputFiles,
  materializeSlackFiles,
  mergeSlackFileReferences,
  slackFileReferences,
} from "./slack-files.js";

test("downloads supported Slack images for native T3 turns", async () => {
  const result = await downloadSlackInputFiles(
    [
      { id: "F1", name: "screen.png" },
      { id: "F2", name: "notes.txt" },
    ],
    {
      downloader: {
        async downloadFile(fileId) {
          return fileId === "F1"
            ? {
                data: new Uint8Array([1, 2, 3]),
                name: "screen.png",
                mimetype: "image/png",
              }
            : {
                data: new TextEncoder().encode("notes"),
                name: "notes.txt",
                mimetype: "text/plain",
              };
        },
      },
    },
  );

  assert.deepEqual(result.files, [
    {
      name: "screen.png",
      mimetype: "image/png",
      sizeBytes: 3,
      dataBase64: "AQID",
    },
  ]);
  assert.match(result.warnings[0] ?? "", /not a supported image/);
});

test("normalizes and deduplicates Slack event files", () => {
  assert.deepEqual(
    mergeSlackFileReferences(
      slackFileReferences([
        {
          id: "F123",
          title: "screenshot.png",
          mimetype: "image/png",
          size: 4,
        },
      ]),
      [{ id: "F123", name: "duplicate.png" }],
    ),
    [
      {
        id: "F123",
        name: "screenshot.png",
        mimetype: "image/png",
        size: 4,
      },
    ],
  );
});

test("materializes Slack images for native harness inspection and cleans up", async (t) => {
  const worktree = await fs.mkdtemp(
    path.join(os.tmpdir(), "compadre-slack-files-test-"),
  );
  t.after(() => fs.rm(worktree, { recursive: true, force: true }));
  const materialized = await materializeSlackFiles(
    [{ id: "F123", name: "../unsafe screenshot.png" }],
    {
      downloader: {
        async downloadFile() {
          return {
            data: new Uint8Array([137, 80, 78, 71]),
            name: "../unsafe screenshot.png",
            mimetype: "image/png",
          };
        },
      },
      directoryPrefix: path.join(worktree, ".compadre-attachments-"),
    },
  );

  const pathMatch = materialized.prompt.match(/available at ("[^"]+")/);
  assert.ok(pathMatch);
  const imagePath = JSON.parse(pathMatch[1]) as string;
  assert.equal(imagePath.startsWith(worktree), true);
  assert.match(imagePath, /1-unsafe_screenshot\.png$/);
  assert.deepEqual(
    new Uint8Array(await fs.readFile(imagePath)),
    new Uint8Array([137, 80, 78, 71]),
  );

  await materialized.cleanup();
  await assert.rejects(fs.access(imagePath));
});

test("keeps a failed download visible without failing the run", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const materialized = await materializeSlackFiles(
    [{ id: "F404", name: "missing.png" }],
    {
      downloader: {
        async downloadFile() {
          throw new Error("file_not_found");
        },
      },
    },
  );

  assert.match(materialized.prompt, /F404/);
  assert.match(materialized.prompt, /file_not_found/);
  await materialized.cleanup();
});

test("prepares Slack images for upload into a remote sandbox", async () => {
  const materialized = await materializeSlackFiles(
    [{ id: "F123", name: "diagram.png" }],
    {
      downloader: {
        async downloadFile() {
          return {
            data: new Uint8Array([1, 2, 3]),
            name: "diagram.png",
            mimetype: "image/png",
          };
        },
      },
      promptDirectory: "/workspace/.attachments",
    },
  );

  assert.match(
    materialized.prompt,
    /\/workspace\/\.attachments\/1-diagram\.png/,
  );
  assert.deepEqual(materialized.uploads, [
    {
      path: "/workspace/.attachments/1-diagram.png",
      data: new Uint8Array([1, 2, 3]),
    },
  ]);
  await materialized.cleanup();
});
