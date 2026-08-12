import assert from "node:assert/strict";
import test from "node:test";
import type { PullRequestWatchService } from "./pr-watch.js";
import { startConfiguredPullRequestWatch } from "./pr-watch-runtime.js";

const service = {} as PullRequestWatchService;

test("initializes a repository before starting a relay-only PR watcher", async () => {
  const events: string[] = [];

  await startConfiguredPullRequestWatch(false, {
    getService: async () => service,
    ensureRepository: () => void events.push("repository"),
    startReconciler: () => void events.push("reconciler"),
  });

  assert.deepEqual(events, ["repository", "reconciler"]);
});

test("reuses an existing agent repository for the PR watcher", async () => {
  const events: string[] = [];

  await startConfiguredPullRequestWatch(true, {
    getService: async () => service,
    ensureRepository: () => void events.push("repository"),
    startReconciler: () => void events.push("reconciler"),
  });

  assert.deepEqual(events, ["reconciler"]);
});

test("does not initialize a repository when PR watching is unconfigured", async () => {
  const events: string[] = [];

  await startConfiguredPullRequestWatch(false, {
    getService: async () => null,
    ensureRepository: () => void events.push("repository"),
    startReconciler: () => void events.push("reconciler"),
  });

  assert.deepEqual(events, []);
});
