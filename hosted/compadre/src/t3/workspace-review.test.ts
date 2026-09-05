import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createT3DirectoryRoutes } from "../routes/t3-directory.js";
import { memoryPersistence } from "@tanstack/ai-persistence";
import { T3ArtifactStore } from "./artifact-store.js";
import { captureWorkspaceReview } from "./workspace-review-capture.js";
import {
  WorkspaceReviewStore,
  readWorkspaceReview,
  readWorkspaceReviewFile,
  reviewDigest,
} from "./workspace-review.js";

test("captures immutable checkpoints and serves context after the entire checkout disappears", async (t) => {
  const previousKey = process.env.COMPADRE_API_KEY;
  process.env.COMPADRE_API_KEY = "review-test-key";
  t.after(() => {
    if (previousKey === undefined) delete process.env.COMPADRE_API_KEY;
    else process.env.COMPADRE_API_KEY = previousKey;
  });
  const cwd = mkdtempSync(join(tmpdir(), "compadre-review-test-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Review test");
    git("config", "user.email", "review@example.test");
    writeFileSync(
      join(cwd, "context.ts"),
      "// unchanged context\nexport const count = 1;\n",
    );
    writeFileSync(join(cwd, "gone.txt"), "deleted\n");
    writeFileSync(join(cwd, "before.txt"), "rename me\n");
    git("add", ".");
    git("commit", "-m", "initial");
    git("update-ref", "refs/review/0", "HEAD");
    writeFileSync(
      join(cwd, "context.ts"),
      "// unchanged context\nexport const count = 2;\n",
    );
    rmSync(join(cwd, "gone.txt"));
    renameSync(join(cwd, "before.txt"), join(cwd, "after.txt"));
    writeFileSync(join(cwd, "new file.txt"), "new\n");
    writeFileSync(join(cwd, "binary.bin"), Buffer.from([0, 255, 1]));
    writeFileSync(join(cwd, "large.txt"), "x".repeat(1024 * 1024 + 1));
    git("add", ".");
    const tree = git("write-tree");
    const checkpoint = git(
      "commit-tree",
      tree,
      "-p",
      "HEAD",
      "-m",
      "checkpoint",
    );
    git("update-ref", "refs/review/1", checkpoint);
    // The mutable working tree is intentionally different from the checkpoint.
    writeFileSync(join(cwd, "context.ts"), "later unsaved work\n");
    const capture = await captureWorkspaceReview(
      {
        process: {
          async exec(command) {
            const stdout = execFileSync("/bin/sh", ["-c", command], {
              encoding: "utf8",
              maxBuffer: 30 * 1024 * 1024,
            });
            return { stdout, stderr: "", exitCode: 0 };
          },
        },
        fs: {
          async readBytes(path) {
            return readFileSync(path);
          },
          async remove(path) {
            rmSync(path);
          },
        },
      },
      {
        cwd,
        fromRef: "refs/review/0",
        initialRef: "refs/review/0",
        toRef: "refs/review/1",
        turnId: "turn-1",
        turnCount: 1,
      },
    );
    const turn = capture.comparisons.find((c) => c.kind === "turn")!;
    assert.match(turn.diff, /count = 2/);
    assert.doesNotMatch(turn.diff, /later unsaved/);
    assert.equal(
      turn.files.find((f) => f.newPath === "after.txt")?.kind,
      "renamed",
    );
    assert.equal(
      turn.files.find((f) => f.newPath === "gone.txt")?.kind,
      "deleted",
    );
    assert.match(
      turn.files.find((f) => f.newPath === "binary.bin")?.unavailableReason ??
        "",
      /Binary/,
    );
    assert.equal(turn.truncated, true);
    const objects = new Map<string, Uint8Array>();
    const metadata = memoryPersistence().stores.metadata;
    let puts = 0;
    const artifacts = new T3ArtifactStore(
      {
        async put({ key, bytes }) {
          puts++;
          objects.set(key, bytes);
        },
        async get(key) {
          const bytes = objects.get(key);
          if (!bytes) throw new Error("missing object");
          return bytes;
        },
        async check() {},
      },
      metadata,
    );
    const store = new WorkspaceReviewStore(artifacts, metadata);
    const outputBytes = Buffer.from("new\n");
    const outputId = reviewDigest(outputBytes);
    await artifacts.publish({
      runId: "run-1",
      artifactId: outputId,
      bytes: outputBytes,
      path: "new file.txt",
      name: "new file.txt",
      title: "User output",
      mimetype: "text/custom-output",
    });
    const saved = await store.publish("run-1", "thread-1", capture);
    assert.equal(
      (await artifacts.read("run-1", outputId))?.metadata.mimetype,
      "text/custom-output",
      "saved context must not overwrite metadata for an identical output artifact",
    );
    const originalPuts = puts;
    assert.deepEqual(await store.publish("run-1", "thread-1", capture), saved);
    assert.equal(puts, originalPuts, "delivery retry reuses the publication");
    rmSync(cwd, { recursive: true });
    const routes = createT3DirectoryRoutes({
      enabled: () => true,
      createId: () => "unused",
      watchTurn() {},
      async getGateway() {
        throw new Error("A review read must never obtain a worker gateway");
      },
      async getReviewStore() {
        return store;
      },
    });
    const request = (threadId: string, auth = true) =>
      routes.request("/hosted/t3/review", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(auth ? { authorization: "Bearer review-test-key" } : {}),
        },
        body: JSON.stringify({ threadId, reference: saved.reference }),
      });
    assert.equal((await request("thread-1", false)).status, 401);
    assert.equal((await request("thread-2")).status, 404);
    const response = await request("thread-1");
    assert.equal(response.status, 200);
    assert.deepEqual(
      ((await response.json()) as { comparisons: unknown }).comparisons,
      capture.comparisons,
    );
    await store.authorize("thread-1", saved.reference);
    await assert.rejects(
      store.authorize("thread-2", saved.reference),
      /belong/,
    );
    assert.deepEqual(
      (await readWorkspaceReview(artifacts, saved.reference)).comparisons,
      capture.comparisons,
    );
    const input = {
      sourceKind: "turn",
      baseRef: turn.baseRef,
      headRef: turn.headRef,
      oldPath: "context.ts",
      newPath: "context.ts",
    };
    assert.deepEqual(
      await readWorkspaceReviewFile(artifacts, saved.reference, input),
      {
        oldContents: "// unchanged context\nexport const count = 1;\n",
        newContents: "// unchanged context\nexport const count = 2;\n",
      },
    );
    await assert.rejects(
      readWorkspaceReviewFile(artifacts, saved.reference, {
        ...input,
        oldPath: "not-captured",
      }),
      /not in/,
    );
    await assert.rejects(
      readWorkspaceReviewFile(artifacts, saved.reference, {
        ...input,
        oldPath: "binary.bin",
        newPath: "binary.bin",
      }),
      /Binary/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
