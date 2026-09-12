import { filterComposerPullRequestMatches } from "@t3tools/shared/composerPullRequestMatches";
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

it("keeps an older exact PR in the mobile menu ahead of twenty newer substring matches", () => {
  const exact = {
    number: 42,
    projectId: "project",
    repository: "example/repo",
    updatedAt: "2025-01-01",
  };
  const recent = Array.from({ length: 25 }, (_, index) => ({
    ...exact,
    number: 4200 + index,
    updatedAt: "2026-01-01",
  }));
  const matches = filterComposerPullRequestMatches({
    entries: [exact, ...recent, exact],
    projectId: exact.projectId,
    repository: exact.repository,
    query: "42",
    limit: 20,
  });
  expect(matches).toHaveLength(20);
  expect(matches[0]).toEqual(exact);
  expect(matches.filter((entry) => entry.number === 42)).toHaveLength(1);
});
