import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { buildCheckpointDiffTargets, normalizeComposerPathSearchQuery } from "./queryTargets";

describe("appQueries", () => {
  it("normalizes composer path search input", () => {
    expect(normalizeComposerPathSearchQuery("  src/app  ")).toBe("src/app");
    expect(normalizeComposerPathSearchQuery(null)).toBe("");
  });

  it("keeps checkpoint revisions in the cache target and out of the RPC input", () => {
    const target = {
      environmentId: EnvironmentId.make("environment-a"),
      threadId: ThreadId.make("thread-a"),
      fromTurnCount: 0,
      toTurnCount: 1,
      ignoreWhitespace: false,
      cacheScope: "compadre-review:published",
    };
    expect(buildCheckpointDiffTargets(target).turn).toMatchObject({
      cacheScope: target.cacheScope,
    });
    expect(buildCheckpointDiffTargets(target).turn?.input).not.toHaveProperty("cacheScope");
    expect(buildCheckpointDiffTargets({ ...target, toTurnCount: 2 }).fullThread).toMatchObject({
      cacheScope: target.cacheScope,
    });
  });

  it("routes cumulative ranges through the full-thread diff query", () => {
    const environmentId = EnvironmentId.make("environment-a");
    const threadId = ThreadId.make("thread-a");

    expect(
      buildCheckpointDiffTargets({
        environmentId,
        threadId,
        fromTurnCount: 0,
        toTurnCount: 4,
        ignoreWhitespace: true,
      }),
    ).toEqual({
      fullThread: {
        environmentId,
        input: {
          threadId,
          toTurnCount: 4,
          ignoreWhitespace: true,
        },
      },
      turn: null,
    });
  });

  it.each([
    [0, 1],
    [3, 4],
  ])(
    "routes the individual range %i–%i through the turn diff query",
    (fromTurnCount, toTurnCount) => {
      const environmentId = EnvironmentId.make("environment-a");
      const threadId = ThreadId.make("thread-a");

      expect(
        buildCheckpointDiffTargets({
          environmentId,
          threadId,
          fromTurnCount,
          toTurnCount,
          ignoreWhitespace: false,
        }),
      ).toEqual({
        fullThread: null,
        turn: {
          environmentId,
          input: {
            threadId,
            fromTurnCount,
            toTurnCount,
            ignoreWhitespace: false,
          },
        },
      });
    },
  );
});
