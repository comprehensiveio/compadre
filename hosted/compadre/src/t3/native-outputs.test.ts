import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { memoryPersistence } from "@tanstack/ai-persistence";
import { T3Client } from "./client.js";
import { T3ArtifactStore } from "./artifact-store.js";
import { nativeOutputCheckpoints, nativeOutputRunId, publishNativeRunOutputs } from "./native-outputs.js";

test("late native checkpoints publish stable output commands for their own turn", async () => {
  const metadata = memoryPersistence().stores.metadata;
  const bytes = Buffer.from("late background file");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const checkpoint = { turnId: "background-turn", checkpointRef: "refs/t3/checkpoints/worker/turn/2", checkpointTurnCount: 2, status: "ready" as const };
  assert.deepEqual(nativeOutputCheckpoints([
    { type: "thread.turn-diff-completed", payload: checkpoint },
    { type: "thread.turn-diff-completed", payload: { ...checkpoint, checkpointRef: "compadre-review:published" } },
  ]), [checkpoint]);
  const commands: unknown[] = [];
  let uploads = 0;
  const client = new T3Client("https://worker.example", "unused");
  client.threadSnapshot = async () => ({ snapshotSequence: 9, thread: { id: "worker", projectId: "project", title: "Native",
    modelSelection: { instanceId: "codex", model: "test" }, messages: [], latestTurn: null, session: null } });
  client.uploadAttachment = async () => { uploads++; return { id: "worker-file", type: "file", name: "late.txt", mimeType: "text/plain", sizeBytes: bytes.length }; };
  client.publishNativeOutput = async (command) => { commands.push(command); };
  const binding = { canonicalThreadId: "central", t3ThreadId: "worker", projectId: "project", sandboxId: "sandbox", baseUrl: client.baseUrl,
    providerInstanceId: "codex", modelSelection: { instanceId: "codex", model: "test" }, status: "ready" as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const artifactStore = new T3ArtifactStore({ put: async () => {}, get: async () => bytes, check: async () => {} }, metadata);
  const runId = nativeOutputRunId("worker", checkpoint.turnId);
  const input: Parameters<typeof publishNativeRunOutputs>[0] = { metadata, artifactStore, reviews: null, checkpoint,
    turn: { binding, dispatch: { threadId: "worker", messageId: "parent-user", commandId: "parent-command", sequence: 1, createdAt: binding.createdAt } },
    request: { runId, canonicalThreadId: "central", provider: "codex", title: "Native", text: "", modelSelection: binding.modelSelection, inputFiles: [], collectArtifacts: true, createdAt: binding.createdAt },
    gateway: { attachWorker: async () => ({ binding, environment: { sandboxId: "sandbox", projectId: "project", client } }),
      captureWorkspaceReview: async () => { throw new Error("reviews disabled"); },
      collectOutputArtifacts: async (_turn, publish) => { await publish({ bytes, digest, filename: "late.txt", path: "late.txt", title: "Late", mimetype: "text/plain" }); return { published: [{path: "late.txt", digest}], failures: [] }; },
    },
  };
  await publishNativeRunOutputs(input);
  await publishNativeRunOutputs(input);
  assert.equal(uploads, 1);
  assert.equal(commands.length, 2);
  for (const command of commands) {
    assert.ok(command && typeof command === "object" && "turnId" in command && "commandId" in command);
    assert.equal(command.turnId, "background-turn");
    assert.equal(command.commandId, `output:${runId}:${digest}`);
  }
});
