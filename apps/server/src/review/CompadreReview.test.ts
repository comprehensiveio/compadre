import { assert, it } from "@effect/vitest";
import { CheckpointRef, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { makeCompadreReview } from "./CompadreReview.ts";

const reference = `compadre-review:run-1:${"a".repeat(64)}`;
const capturedAt = "2026-09-05T12:00:00.000Z";
const threadId = ThreadId.make("thread-1");
const projection = {
  getThreadCheckpointContext: () =>
    Effect.succeed(
      Option.some({
        threadId,
        projectId: ProjectId.make("project-1"),
        workspaceRoot: "/worker/no-longer-exists",
        worktreePath: null,
        checkpoints: [
          {
            turnId: TurnId.make("turn-1"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make(reference),
            status: "ready" as const,
            files: [],
            completedAt: capturedAt,
            assistantMessageId: null,
          },
        ],
      }),
    ),
};
const manifest = {
  version: 1,
  capturedAt,
  workerTurnId: "native-turn",
  checkpointTurnCount: 1,
  comparisons: ["turn", "thread", "branch-range", "working-tree"].map((kind) => ({
    kind,
    baseRef: "before",
    headRef: "after",
    baseLabel: "main",
    headLabel: "feature",
    diff: "saved patch",
    ignoreWhitespaceDiff: "whitespace patch",
    files: [],
    truncated: false,
  })),
};

it.effect("reads hosted preview and turn patches entirely through durable review storage", () =>
  Effect.gen(function* () {
    let calls = 0;
    const review = makeCompadreReview(
      projection,
      { COMPADRE_NATIVE_T3_URL: "https://controller.example", COMPADRE_API_KEY: "test-key" },
      async (url, init) => {
        calls++;
        assert.equal(String(url), "https://controller.example/hosted/t3/review");
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
        return Response.json(manifest);
      },
    )!;
    const preview = yield* review.getDiffPreview({
      threadId,
      cwd: "/worker/no-longer-exists",
      ignoreWhitespace: false,
    });
    assert.equal(preview.sources[0]?.diff, "saved patch");
    assert.deepStrictEqual(preview.snapshot, { reference, capturedAt });
    const turn = yield* review.getTurnDiff({
      threadId,
      fromTurnCount: 0,
      toTurnCount: 1,
      ignoreWhitespace: true,
    });
    assert.equal(turn.diff, "whitespace patch");
    assert.equal(calls, 2);
    const denied = yield* review
      .getDiffFileContents({
        threadId,
        cwd: "/worker/no-longer-exists",
        snapshotRef: "another-reference",
        sourceKind: "working-tree",
        baseRef: "before",
        headRef: "after",
        oldPath: "file",
        newPath: "file",
        changeType: "change",
      })
      .pipe(Effect.flip);
    assert.match(denied.detail, /does not belong/);
    assert.equal(calls, 2);
  }),
);

it.effect("reports missing old snapshots and storage outages without a worker fallback", () =>
  Effect.gen(function* () {
    const review = makeCompadreReview(
      projection,
      { COMPADRE_NATIVE_T3_URL: "https://controller.example" },
      async () => new Response(null, { status: 503 }),
    )!;
    const missing = yield* review
      .getTurnDiff({ threadId, fromTurnCount: 1, toTurnCount: 2 })
      .pipe(Effect.flip);
    assert.match(missing.detail, /No saved diff/);
    const outage = yield* review.getDiffPreview({ threadId, cwd: "/missing" }).pipe(Effect.flip);
    assert.match(outage.detail, /does not start a worker/);
    assert.equal(makeCompadreReview(projection, {}), undefined);
  }),
);

it.effect("distinguishes an individual first saved slot from the worker's full history", () =>
  Effect.gen(function* () {
    const review = makeCompadreReview(
      projection,
      { COMPADRE_NATIVE_T3_URL: "https://controller.example" },
      async () =>
        Response.json({
          ...manifest,
          checkpointTurnCount: 2,
          comparisons: manifest.comparisons.map((comparison) => ({
            ...comparison,
            diff: comparison.kind === "turn" ? "+line 20 updated" : "+all 40 lines",
          })),
        }),
    )!;
    const input = { threadId, fromTurnCount: 0, toTurnCount: 1, ignoreWhitespace: false };
    assert.equal((yield* review.getTurnDiff(input)).diff, "+line 20 updated");
    assert.equal((yield* review.getTurnDiff(input, true)).diff, "+all 40 lines");
  }),
);
