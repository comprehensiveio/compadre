import assert from "node:assert/strict";
import test from "node:test";
import type { PullRequestWatchService } from "./pr-watch.js";
import { watchCompPrDeployment } from "./slack-deployment-watch-tool.js";

test("registers a durable deployment notification for the exact Slack thread", async () => {
  const calls: unknown[] = [];
  const service = {
    async register(request: unknown, destination: unknown) {
      calls.push({ request, destination });
      return { created: true, watchId: "watch-1" };
    },
  } as unknown as PullRequestWatchService;

  const result = await watchCompPrDeployment(
    {
      prNumber: 1234,
      channelId: "C123",
      threadTs: "1712345678.000100",
    },
    { teamId: "T123", getWatchService: async () => service },
  );

  assert.deepEqual(calls, [
    {
      request: {
        prNumber: 1234,
        prUrl: "https://github.com/comprehensiveio/comp/pull/1234",
      },
      destination: {
        teamId: "T123",
        channelId: "C123",
        threadTs: "1712345678.000100",
      },
    },
  ]);
  assert.deepEqual(result, {
    created: true,
    watchId: "watch-1",
    pr_number: 1234,
    pr_url: "https://github.com/comprehensiveio/comp/pull/1234",
    message: "Watching PR #1234 for production deployment.",
  });
});
