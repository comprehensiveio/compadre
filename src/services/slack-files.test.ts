import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  materializeSlackFiles,
  mergeSlackFileReferences,
  slackFileReferences,
} from "./slack-files.js";

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
