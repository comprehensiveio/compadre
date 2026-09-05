import {
  ReviewDiffFileContentsResult,
  WorkspaceReviewManifest,
  VcsUnsupportedOperationError,
  type ReviewDiffPreviewInput,
  type ReviewDiffFileContentsInput,
  type OrchestrationGetTurnDiffInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

const encodeBody = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeManifest = Schema.decodeUnknownSync(WorkspaceReviewManifest);
const decodeContents = Schema.decodeUnknownSync(ReviewDiffFileContentsResult);
const unavailable = (detail: string) =>
  new VcsUnsupportedOperationError({
    operation: "CompadreReview.read",
    kind: "git",
    detail,
  });

/** Hosted reads use only central checkpoint metadata and durable controller objects. */
export function makeCompadreReview(
  projection: Pick<ProjectionSnapshotQueryShape, "getThreadCheckpointContext">,
  environment: NodeJS.ProcessEnv = process.env,
  fetcher: (url: URL, init: RequestInit) => Promise<Response> = globalThis.fetch,
) {
  const endpoint = environment.COMPADRE_NATIVE_T3_URL?.trim();
  if (!endpoint) return undefined;
  const url = new URL("/hosted/t3/review", endpoint);
  const token = environment.COMPADRE_API_KEY?.trim();
  const context = Effect.fn("CompadreReview.context")(function* (threadId: ThreadId | undefined) {
    if (!threadId)
      return yield* unavailable("A thread is required to read saved workspace changes.");
    const value = yield* projection
      .getThreadCheckpointContext(threadId)
      .pipe(
        Effect.mapError(() => unavailable("Saved workspace metadata is temporarily unavailable.")),
      );
    if (Option.isNone(value)) return yield* unavailable("Thread is unavailable.");
    return value.value;
  });
  const request = (body: object) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetcher(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token ?? ""}`, "content-type": "application/json" },
          body: encodeBody(body),
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`Review storage returned ${response.status}`);
        return (await response.json()) as unknown;
      },
      catch: () =>
        unavailable(
          "Saved changes are temporarily unavailable. Reading this view does not start a worker.",
        ),
    });
  const manifest = (threadId: ThreadId, reference: string) =>
    request({ threadId, reference }).pipe(
      Effect.flatMap((value) =>
        Effect.try({
          try: () => decodeManifest(value),
          catch: () => unavailable("Saved review data could not be decoded."),
        }),
      ),
    );
  const referenceFor = (reference: string | undefined) =>
    reference?.startsWith("compadre-review:")
      ? Effect.succeed(reference)
      : Effect.fail(
          unavailable(
            "No saved diff is available for this turn. New turns save changes automatically; opening this view does not start a worker.",
          ),
        );

  return {
    getDiffPreview: Effect.fn("CompadreReview.preview")(function* (input: ReviewDiffPreviewInput) {
      const value = yield* context(input.threadId);
      const latest = [...value.checkpoints].sort(
        (a, b) => b.checkpointTurnCount - a.checkpointTurnCount,
      )[0];
      const reference = yield* referenceFor(latest?.checkpointRef);
      const saved = yield* manifest(value.threadId, reference);
      const comparisons = saved.comparisons.filter(
        (comparison) => comparison.kind === "branch-range" || comparison.kind === "working-tree",
      );
      const branch = comparisons.find((comparison) => comparison.kind === "branch-range");
      if (
        input.baseRef &&
        input.baseRef !== branch?.baseRef &&
        input.baseRef !== branch?.baseLabel
      ) {
        return yield* unavailable("That base revision was not captured in this snapshot.");
      }
      return {
        cwd: input.cwd,
        generatedAt: DateTime.makeUnsafe(saved.capturedAt),
        snapshot: { reference, capturedAt: saved.capturedAt },
        sources: comparisons.map((comparison) => ({
          id: comparison.kind,
          kind: comparison.kind as "branch-range" | "working-tree",
          title:
            comparison.kind === "branch-range" ? comparison.baseLabel : "Captured working tree",
          baseRef: comparison.baseRef,
          headRef: comparison.headRef,
          diff:
            (input.ignoreWhitespace ?? true) ? comparison.ignoreWhitespaceDiff : comparison.diff,
          diffHash: `${reference}:${comparison.kind}:${input.ignoreWhitespace ?? true}`,
          truncated: comparison.truncated,
          unavailableFiles: comparison.files.flatMap((file) =>
            file.unavailableReason ? [{ path: file.newPath, reason: file.unavailableReason }] : [],
          ),
        })),
      };
    }),
    getDiffFileContents: Effect.fn("CompadreReview.contents")(function* (
      input: ReviewDiffFileContentsInput,
    ) {
      const value = yield* context(input.threadId);
      if (!value.checkpoints.some((checkpoint) => checkpoint.checkpointRef === input.snapshotRef)) {
        return yield* unavailable("Saved comparison does not belong to this thread.");
      }
      const reference = yield* referenceFor(input.snapshotRef);
      const raw = yield* request({
        ...input,
        threadId: value.threadId,
        reference,
        operation: "contents",
      });
      return yield* Effect.try({
        try: () => decodeContents(raw),
        catch: () => unavailable("Saved file contents could not be decoded."),
      });
    }),
    getTurnDiff: Effect.fn("CompadreReview.turn")(function* (
      input: OrchestrationGetTurnDiffInput,
      fullThread = false,
    ) {
      const value = yield* context(input.threadId);
      const checkpoint = value.checkpoints.find(
        (item) => item.checkpointTurnCount === input.toTurnCount,
      );
      const reference = yield* referenceFor(checkpoint?.checkpointRef);
      const saved = yield* manifest(value.threadId, reference);
      if (input.fromTurnCount !== 0 && input.fromTurnCount !== input.toTurnCount - 1) {
        return yield* unavailable(
          "Only individual turns and changes since thread start were captured.",
        );
      }
      const kind =
        fullThread || (input.fromTurnCount === 0 && input.toTurnCount > 1) ? "thread" : "turn";
      const comparison = saved.comparisons.find((item) => item.kind === kind);
      if (!comparison) return yield* unavailable("This comparison was not captured.");
      return {
        threadId: input.threadId,
        fromTurnCount: input.fromTurnCount,
        toTurnCount: input.toTurnCount,
        diff: (input.ignoreWhitespace ?? true) ? comparison.ignoreWhitespaceDiff : comparison.diff,
        truncated: comparison.truncated,
        capturedAt: saved.capturedAt,
      };
    }),
  };
}
