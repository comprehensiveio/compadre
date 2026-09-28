import { z } from "zod";
import { createHash } from "node:crypto";
import { collectNativeT3ArtifactEvents } from "./artifact-events.js";
import type { T3ArtifactStore } from "./artifact-store.js";
import type { T3ThreadSnapshot } from "./client.js";
import type { T3CommandClient, T3Gateway, T3GatewayTurn } from "./gateway.js";
import type { NativeEventPage } from "./native-events.js";
import type { MetadataStore } from "./storage.js";
import type { NativeT3RunRequest } from "./run-request-store.js";
import type { NativeT3RunRequestStore } from "./run-request-store.js";
import type { WorkspaceReviewStore } from "./workspace-review.js";

const attachmentSchema = z.object({ id: z.string(), type: z.enum(["image", "file"]), name: z.string(), mimeType: z.string(), sizeBytes: z.number() });
const checkpointEventSchema = z.object({ type: z.literal("thread.turn-diff-completed"), payload: z.object({
  turnId: z.string(), checkpointRef: z.string(), checkpointTurnCount: z.number().int().positive(),
  status: z.literal("ready"),
}) });
const backgroundEventSchema = z.object({ type: z.literal("thread.activity-appended"), payload: z.object({
  activity: z.object({ kind: z.enum(["task.updated", "task.completed"]), turnId: z.string().min(1),
    payload: z.object({ taskId: z.string().min(1), status: z.enum(["idle", "completed"]) }),
  }),
}) });
const completedTurnEventSchema = z.object({ type: z.literal("thread.activity-appended"), payload: z.object({
  activity: z.object({ kind: z.literal("provider.turn.completed"), turnId: z.string().min(1), payload: z.object({ state: z.literal("completed") }) }),
}) });

export function nativeCompletedOutputTurns(events: unknown[]): string[] {
  return [...new Set(events.flatMap((event) => {
    const parsed = completedTurnEventSchema.safeParse(event);
    return parsed.success ? [parsed.data.payload.activity.turnId] : [];
  }))];
}

/** Child completion can happen after the parent's final checkpoint. */
export function nativeBackgroundOutputTurns(events: unknown[]): string[] {
  return [...new Set(events.flatMap((event) => {
    const parsed = backgroundEventSchema.safeParse(event);
    return parsed.success ? [parsed.data.payload.activity.turnId] : [];
  }))];
}

/** GET pages carry events; HEAD owns current provider and child liveness. */
export async function nativeQuiescentOutputTurn(client: Pick<T3CommandClient, "nativeEventPage" | "threadSnapshot">, threadId: string, signal?: AbortSignal): Promise<string | null> {
  const head = await client.nativeEventPage?.({ threadId, offset: "-1", head: true, signal });
  if (head?.sessionStatus !== "ready" || head.backgroundLiveness !== null) return null;
  const snapshot = await client.threadSnapshot(threadId, signal);
  return snapshot.thread.latestTurn?.state === "completed" ? snapshot.thread.latestTurn.turnId : null;
}

/** Recover a completion already acknowledged by an older consumer. */
export function nativeOutputReconciler() {
  let catchUpPending = true;
  let pendingTurnId: string | null = null;
  return {
    read: async (client: Pick<T3CommandClient, "nativeEventPage" | "threadSnapshot">, threadId: string,
      page: NativeEventPage, signal?: AbortSignal): Promise<string | null> => {
      if (!catchUpPending || !page.upToDate) return null;
      pendingTurnId ??= await nativeQuiescentOutputTurn(client, threadId, signal);
      return pendingTurnId;
    },
    acknowledge: (turnId: string) => {
      if (pendingTurnId !== turnId) return;
      catchUpPending = false;
      pendingTurnId = null;
    },
  };
}

export function nativeOutputCheckpoints(events: unknown[]) {
  return events.flatMap((event) => {
    const parsed = checkpointEventSchema.safeParse(event);
    return parsed.success && !parsed.data.payload.checkpointRef.startsWith("compadre-review:") ? [parsed.data.payload] : [];
  });
}

export const nativeOutputRunId = (threadId: string, turnId: string) =>
  `native-${createHash("sha256").update(JSON.stringify([threadId, turnId])).digest("hex")}`;

/** Resolve the owning request from the durable turn/run association, not the latest active run. */
export async function nativeOutputContextForTurn(input: {
  requests: Pick<NativeT3RunRequestStore, "getRunIdForTurn" | "getDispatch" | "getRequest">;
  snapshot: T3ThreadSnapshot; canonicalThreadId: string; turnId: string; currentRunId?: string;
}) {
  const mappedRunId = await input.requests.getRunIdForTurn(input.canonicalThreadId, input.turnId);
  const fallback = !mappedRunId && input.currentRunId ? await input.requests.getDispatch(input.currentRunId) : null;
  const latest = input.snapshot.thread.latestTurn;
  const fallbackMessage = fallback && input.snapshot.thread.messages.find((message) =>
    message.role === "user" && message.id === fallback.dispatch.messageId);
  const runId = mappedRunId
    ?? (latest?.turnId === input.turnId && fallbackMessage && Date.parse(fallback.dispatch.createdAt) <= Date.parse(latest.requestedAt)
      ? input.currentRunId : null);
  // Pre-rollout turns may have no mapping. Never attach their files to a newer run.
  if (!runId) return null;
  const [request, dispatch] = await Promise.all([
    input.requests.getRequest(runId, { includeInputFiles: false }), input.requests.getDispatch(runId),
  ]);
  if (!request || !dispatch) throw new Error("Native output has no durable run context");
  return { request, dispatch };
}

/** Files and immutable diffs become native worker commands and follow journal delivery. */
export async function publishNativeRunOutputs(input: {
  gateway: Pick<T3Gateway, "attachWorker" | "captureWorkspaceReview" | "collectOutputArtifacts">; artifactStore: T3ArtifactStore; reviews: Pick<WorkspaceReviewStore, "published" | "publish"> | null;
  turn: T3GatewayTurn; request: NativeT3RunRequest; metadata: MetadataStore;
} & ({ checkpoint: ReturnType<typeof nativeOutputCheckpoints>[number] } | { backgroundTurnId: string })): Promise<number> {
  const { turn, request } = input;
  const attached = await input.gateway.attachWorker(request.canonicalThreadId);
  if (!attached || attached.binding.sandboxId !== turn.binding.sandboxId) throw new Error("Output worker binding changed");
  const client = attached.environment.client;
  if (!client.publishNativeOutput || !client.uploadAttachment) throw new Error("Worker cannot publish native outputs");
  const turnId = "checkpoint" in input ? input.checkpoint.turnId : input.backgroundTurnId;
  let published = 0;
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
      published++;
    },
  });
  if (!input.reviews || !("checkpoint" in input)) return published;
  const saved = await input.reviews.published(request.runId)
    ?? await input.reviews.publish(request.runId, request.canonicalThreadId, await input.gateway.captureWorkspaceReview(turn, input.checkpoint));
  const finished = await client.threadSnapshot(turn.binding.t3ThreadId);
  const checkpoint = input.checkpoint;
  const assistantMessageId = [...finished.thread.messages].reverse().find((message) => message.role === "assistant" && message.turnId === checkpoint.turnId)?.id;
  await client.publishNativeOutput({ type: "thread.turn.diff.complete", commandId: `review:${request.runId}`,
    threadId: turn.binding.t3ThreadId, turnId: checkpoint.turnId, completedAt: saved.capturedAt,
    checkpointRef: saved.reference, status: "ready", files: saved.files,
    checkpointTurnCount: checkpoint.checkpointTurnCount, createdAt: saved.capturedAt,
    ...(assistantMessageId ? { assistantMessageId } : {}),
  });
  return published;
}
