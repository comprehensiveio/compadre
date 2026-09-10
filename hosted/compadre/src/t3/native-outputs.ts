import { z } from "zod";
import { collectNativeT3ArtifactEvents } from "./artifact-events.js";
import type { T3ArtifactStore } from "./artifact-store.js";
import { reviewCheckpointForMessage } from "./client.js";
import type { T3Gateway, T3GatewayTurn } from "./gateway.js";
import type { MetadataStore } from "./storage.js";
import type { NativeT3RunRequest } from "./run-request-store.js";
import type { WorkspaceReviewStore } from "./workspace-review.js";

const attachmentSchema = z.object({ id: z.string(), type: z.enum(["image", "file"]), name: z.string(), mimeType: z.string(), sizeBytes: z.number() });

/** Files and immutable diffs become native worker commands and follow journal delivery. */
export async function publishNativeRunOutputs(input: {
  gateway: T3Gateway; artifactStore: T3ArtifactStore; reviews: WorkspaceReviewStore | null;
  turn: T3GatewayTurn; request: NativeT3RunRequest; metadata: MetadataStore;
}): Promise<void> {
  const { turn, request } = input;
  const attached = await input.gateway.attachWorker(request.canonicalThreadId);
  if (!attached || attached.binding.sandboxId !== turn.binding.sandboxId) throw new Error("Output worker binding changed");
  const client = attached.environment.client;
  if (!client.publishNativeOutput || !client.uploadAttachment) throw new Error("Worker cannot publish native outputs");
  const snapshot = await client.threadSnapshot(turn.binding.t3ThreadId);
  const turnId = snapshot.thread.latestTurn?.turnId;
  if (!turnId) return;
  await collectNativeT3ArtifactEvents({ gateway: input.gateway, artifactStore: input.artifactStore, turn, runId: request.runId,
    slackDestination: request.slackArtifactDestination, botToken: process.env.SLACK_BOT_TOKEN,
    publishNative: async (artifact) => {
      const key = `${turn.binding.t3ThreadId}:${artifact.digest}`;
      const previous = await input.metadata.get("compadre.t3.native-output-uploads.v1", key);
      const attachment = previous ? attachmentSchema.parse(previous) : await client.uploadAttachment!({
        name: artifact.filename, mimeType: artifact.mimetype, bytes: artifact.bytes,
      });
      if (!attachment) throw new Error("Worker attachment upload is unavailable");
      if (!previous) await input.metadata.set("compadre.t3.native-output-uploads.v1", key, attachment);
      await client.publishNativeOutput!({ type: "thread.message.assistant.complete",
        commandId: `output:${request.runId}:${artifact.digest}`, threadId: turn.binding.t3ThreadId,
        messageId: `output:${request.runId}:${artifact.digest}`, attachments: [attachment], turnId,
        createdAt: new Date().toISOString(),
      });
    },
  });
  if (!input.reviews) return;
  const saved = await input.reviews.published(request.runId)
    ?? await input.reviews.publish(request.runId, request.canonicalThreadId, await input.gateway.captureWorkspaceReview(turn));
  const finished = await client.threadSnapshot(turn.binding.t3ThreadId);
  const checkpoint = reviewCheckpointForMessage(finished, turn.dispatch.messageId);
  if (!checkpoint) throw new Error("Native output checkpoint is unavailable");
  await client.publishNativeOutput({ type: "thread.turn.diff.complete", commandId: `review:${request.runId}`,
    threadId: turn.binding.t3ThreadId, turnId: checkpoint.turnId, completedAt: saved.capturedAt,
    checkpointRef: saved.reference, status: "ready", files: saved.files,
    checkpointTurnCount: checkpoint.checkpointTurnCount, createdAt: saved.capturedAt,
    ...(finished.thread.latestTurn?.assistantMessageId ? { assistantMessageId: finished.thread.latestTurn.assistantMessageId } : {}),
  });
}
