import { createHash } from "node:crypto";
import { z } from "zod";
import type { T3ArtifactStore } from "./artifact-store.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const file = z.object({
  oldPath: z.string(),
  newPath: z.string(),
  kind: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  oldBlob: digest.nullable(),
  newBlob: digest.nullable(),
  unavailableReason: z.string().optional(),
});
export const workspaceReviewSchema = z.object({
  version: z.literal(1),
  capturedAt: z.string().datetime(),
  workerTurnId: z.string(),
  checkpointTurnCount: z.number().int().positive(),
  comparisons: z
    .array(
      z.object({
        kind: z.enum(["turn", "thread", "branch-range", "working-tree"]),
        baseRef: z.string(),
        headRef: z.string(),
        baseLabel: z.string(),
        headLabel: z.string(),
        diff: z.string(),
        ignoreWhitespaceDiff: z.string(),
        truncated: z.boolean(),
        files: z.array(file).max(1000),
      }),
    )
    .length(4),
  blobs: z.record(digest, z.string()),
});
export type WorkspaceReview = z.infer<typeof workspaceReviewSchema>;
export const REVIEW_MIMETYPE = "application/vnd.compadre.workspace-review+json";
export const REVIEW_PREFIX = "compadre-review:";
export const reviewDigest = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

export function parseReviewReference(reference: string) {
  const match = /^compadre-review:([a-zA-Z0-9_-]{1,160}):([a-f0-9]{64})$/.exec(
    reference,
  );
  if (!match) throw new Error("Invalid saved review reference");
  return { runId: match[1]!, artifactId: match[2]! };
}

// Keep source-context metadata separate from user-facing output artifacts even
// when both contain identical bytes during the same run.
const reviewStorageRunId = (runId: string) => `workspace-review:${runId}`;

/** Upload contents before the manifest. The event is published only after every object is durable. */
export async function publishWorkspaceReview(
  store: T3ArtifactStore,
  runId: string,
  value: WorkspaceReview,
) {
  const { blobs, ...manifest } = workspaceReviewSchema.parse(value);
  const entries = Object.entries(blobs);
  await Promise.all(
    Array.from({ length: Math.min(8, entries.length) }, async () => {
      for (let entry = entries.pop(); entry; entry = entries.pop()) {
        const [artifactId, contents] = entry;
        const bytes = Buffer.from(contents);
        if (reviewDigest(bytes) !== artifactId)
          throw new Error("Review file integrity mismatch");
        await store.publish({
          runId: reviewStorageRunId(runId),
          artifactId,
          bytes,
          path: `review/blobs/${artifactId}`,
          name: artifactId,
          title: "Review file contents",
          mimetype: "text/plain; charset=utf-8",
        });
      }
    }),
  );
  const bytes = Buffer.from(JSON.stringify(manifest));
  const artifactId = reviewDigest(bytes);
  await store.publish({
    runId: reviewStorageRunId(runId),
    artifactId,
    bytes,
    path: "review/manifest.json",
    name: "manifest.json",
    title: "Workspace review",
    mimetype: REVIEW_MIMETYPE,
  });
  return {
    reference: `${REVIEW_PREFIX}${runId}:${artifactId}`,
    capturedAt: manifest.capturedAt,
    files: manifest.comparisons
      .find((comparison) => comparison.kind === "turn")!
      .files.map((file) => ({
        path: file.newPath,
        kind: file.kind,
        additions: file.additions,
        deletions: file.deletions,
      })),
  };
}

/** Reads only persisted artifacts. It intentionally has no gateway or sandbox dependency. */
export async function readWorkspaceReview(
  store: T3ArtifactStore,
  reference: string,
) {
  const { runId, artifactId } = parseReviewReference(reference);
  const artifact = await store.read(reviewStorageRunId(runId), artifactId);
  if (!artifact || artifact.metadata.mimetype !== REVIEW_MIMETYPE)
    throw new Error("Saved review is unavailable");
  if (reviewDigest(artifact.bytes) !== artifactId)
    throw new Error("Saved review integrity mismatch");
  return workspaceReviewSchema
    .omit({ blobs: true })
    .parse(JSON.parse(Buffer.from(artifact.bytes).toString("utf8")));
}

export async function readWorkspaceReviewFile(
  store: T3ArtifactStore,
  reference: string,
  input: {
    sourceKind: string;
    baseRef: string | null;
    headRef: string | null;
    oldPath: string;
    newPath: string;
  },
) {
  const manifest = await readWorkspaceReview(store, reference);
  const comparison = manifest.comparisons.find(
    (item) =>
      item.kind === input.sourceKind &&
      item.baseRef === input.baseRef &&
      item.headRef === input.headRef,
  );
  const file = comparison?.files.find(
    (item) => item.oldPath === input.oldPath && item.newPath === input.newPath,
  );
  if (!file) throw new Error("File is not in the saved comparison");
  if (file.unavailableReason) throw new Error(file.unavailableReason);
  const { runId } = parseReviewReference(reference);
  const read = async (id: string | null) => {
    if (id === null) return "";
    const object = await store.read(reviewStorageRunId(runId), id);
    if (!object || reviewDigest(object.bytes) !== id)
      throw new Error("Saved file contents are unavailable");
    return Buffer.from(object.bytes).toString("utf8");
  };
  const [oldContents, newContents] = await Promise.all([
    read(file.oldBlob),
    read(file.newBlob),
  ]);
  return { oldContents, newContents };
}

const publicationSchema = z.object({
  threadId: z.string(),
  reference: z.string(),
  capturedAt: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      kind: z.string(),
      additions: z.number(),
      deletions: z.number(),
    }),
  ),
});

/** The small delivery record makes activity retries reuse the first durable publication. */
export class WorkspaceReviewStore {
  constructor(
    readonly artifacts: T3ArtifactStore,
    private readonly metadata: import("./storage.js").MetadataStore,
  ) {}
  async published(runId: string) {
    const value = await this.metadata.get(
      "compadre.t3.workspace-reviews.v1",
      runId,
    );
    return value === null ? null : publicationSchema.parse(value);
  }
  async publish(runId: string, threadId: string, review: WorkspaceReview) {
    const existing = await this.published(runId);
    if (existing) {
      if (existing.threadId !== threadId)
        throw new Error("Review run belongs to another thread");
      return existing;
    }
    const publication = {
      threadId,
      ...(await publishWorkspaceReview(this.artifacts, runId, review)),
    };
    await this.metadata.set(
      "compadre.t3.workspace-reviews.v1",
      runId,
      publication,
    );
    return publication;
  }
  async authorize(threadId: string, reference: string) {
    const publication = await this.published(
      parseReviewReference(reference).runId,
    );
    if (!publication || publication.threadId !== threadId) {
      throw new Error("Saved review does not belong to this thread");
    }
  }
}
