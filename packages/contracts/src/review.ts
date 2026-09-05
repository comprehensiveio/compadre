import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, NonNegativeInt, ThreadId, IsoDateTime } from "./baseSchemas.ts";
import { GitCommandError } from "./git.ts";
import { VcsError } from "./vcs.ts";

export const ReviewDiffPreviewInput = Schema.Struct({
  threadId: Schema.optionalKey(ThreadId),
  cwd: TrimmedNonEmptyString,
  baseRef: Schema.optional(TrimmedNonEmptyString),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type ReviewDiffPreviewInput = typeof ReviewDiffPreviewInput.Type;

export const ReviewDiffPreviewSourceKind = Schema.Literals(["working-tree", "branch-range"]);
export type ReviewDiffPreviewSourceKind = typeof ReviewDiffPreviewSourceKind.Type;

export const ReviewDiffPreviewSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ReviewDiffPreviewSourceKind,
  title: TrimmedNonEmptyString,
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  diff: Schema.String,
  diffHash: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
  unavailableFiles: Schema.optionalKey(
    Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })),
  ),
});
export type ReviewDiffPreviewSource = typeof ReviewDiffPreviewSource.Type;

export const ReviewDiffFileContentsInput = Schema.Struct({
  threadId: Schema.optionalKey(ThreadId),
  snapshotRef: Schema.optionalKey(Schema.String),
  cwd: TrimmedNonEmptyString,
  sourceKind: ReviewDiffPreviewSourceKind,
  changeType: Schema.Literals(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  oldPath: TrimmedNonEmptyString,
  newPath: TrimmedNonEmptyString,
});
export type ReviewDiffFileContentsInput = typeof ReviewDiffFileContentsInput.Type;

export const ReviewDiffFileContentsResult = Schema.Struct({
  oldContents: Schema.String,
  newContents: Schema.String,
});
export type ReviewDiffFileContentsResult = typeof ReviewDiffFileContentsResult.Type;

export const ReviewDiffPreviewResult = Schema.Struct({
  snapshot: Schema.optionalKey(
    Schema.Struct({ reference: Schema.String, capturedAt: IsoDateTime }),
  ),
  cwd: TrimmedNonEmptyString,
  generatedAt: Schema.DateTimeUtc,
  sources: Schema.Array(ReviewDiffPreviewSource),
});
export type ReviewDiffPreviewResult = typeof ReviewDiffPreviewResult.Type;

export const ReviewDiffPreviewError = Schema.Union([VcsError, GitCommandError]);
export type ReviewDiffPreviewError = typeof ReviewDiffPreviewError.Type;

/** Durable worker review metadata transported into the central checkpoint projection. */
export const SavedWorkspaceReview = Schema.Struct({
  reference: Schema.String.check(
    Schema.isPattern(/^compadre-review:[a-zA-Z0-9_-]{1,160}:[a-f0-9]{64}$/),
  ),
  capturedAt: IsoDateTime,
  files: Schema.Array(
    Schema.Struct({
      path: TrimmedNonEmptyString,
      kind: Schema.String,
      additions: NonNegativeInt,
      deletions: NonNegativeInt,
    }),
  ),
});

export const WorkspaceReviewManifest = Schema.Struct({
  version: Schema.Literal(1),
  capturedAt: IsoDateTime,
  workerTurnId: Schema.String,
  checkpointTurnCount: NonNegativeInt,
  comparisons: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["turn", "thread", "branch-range", "working-tree"]),
      baseRef: Schema.String,
      headRef: Schema.String,
      baseLabel: Schema.String,
      headLabel: Schema.String,
      diff: Schema.String,
      ignoreWhitespaceDiff: Schema.String,
      truncated: Schema.Boolean,
      files: Schema.Array(
        Schema.Struct({
          oldPath: Schema.String,
          newPath: Schema.String,
          kind: Schema.String,
          additions: NonNegativeInt,
          deletions: NonNegativeInt,
          oldBlob: Schema.NullOr(Schema.String),
          newBlob: Schema.NullOr(Schema.String),
          unavailableReason: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
});
