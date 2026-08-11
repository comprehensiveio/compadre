import assert from "node:assert/strict";
import test from "node:test";
import {
  PreparedWorktreePool,
  type PreparedWorktreePoolDependencies,
} from "./prepared-worktrees.js";

function fixtureDependencies(options: {
  prepare?: (path: string, signal: AbortSignal) => Promise<void>;
  currentRevision?: () => string | undefined;
  abortController?: AbortController;
  preemptBeforeStart?: boolean;
}) {
  const events: string[] = [];
  const revisions = new Map<string, string>();
  let allocations = 0;
  const dependencies: PreparedWorktreePoolDependencies = {
    createId: () => `prepared-${++allocations}`,
    create: (id) => {
      const path = `/worktrees/${id}`;
      revisions.set(path, "revision-a");
      events.push(`create:${id}`);
      return path;
    },
    prepare: async (path, signal) => {
      events.push(`prepare:${path}`);
      await options.prepare?.(path, signal);
    },
    remove: (id) => events.push(`remove:${id}`),
    currentRevision: options.currentRevision ?? (() => "revision-a"),
    revision: (path) => revisions.get(path),
    runWithBackgroundCapacity: async (task) => {
      events.push("capacity:acquire");
      try {
        if (options.preemptBeforeStart) {
          return { status: "preempted" as const };
        }
        const signal =
          options.abortController?.signal ?? new AbortController().signal;
        try {
          return { status: "completed" as const, value: await task(signal) };
        } catch (error) {
          if (signal.aborted) {
            events.push("capacity:preempted");
            return { status: "preempted" as const };
          }
          throw error;
        }
      } finally {
        events.push("capacity:release");
      }
    },
  };
  return { dependencies, events };
}

test("prepares worktrees under capacity and transfers ownership on claim", async () => {
  const { dependencies, events } = fixtureDependencies({});
  const pool = new PreparedWorktreePool({
    targetSize: 1,
    dependencies,
  });

  await pool.refill();

  assert.deepEqual([...pool.worktreeIds()], ["prepared-1"]);
  assert.deepEqual(events, [
    "capacity:acquire",
    "create:prepared-1",
    "prepare:/worktrees/prepared-1",
    "capacity:release",
  ]);
  assert.deepEqual(pool.claim(), {
    id: "prepared-1",
    path: "/worktrees/prepared-1",
    revision: "revision-a",
  });
  assert.deepEqual([...pool.worktreeIds()], []);
});

test("discards a prepared worktree when the repository revision advances", async () => {
  let currentRevision = "revision-a";
  const { dependencies, events } = fixtureDependencies({
    currentRevision: () => currentRevision,
  });
  const pool = new PreparedWorktreePool({
    targetSize: 1,
    dependencies,
  });
  await pool.refill();

  currentRevision = "revision-b";

  assert.equal(pool.claim(), undefined);
  assert.equal(events.at(-1), "remove:prepared-1");
  assert.deepEqual([...pool.worktreeIds()], []);
});

test("reconciles stale cached worktrees after a repository refresh", async () => {
  let currentRevision = "revision-a";
  const { dependencies, events } = fixtureDependencies({
    currentRevision: () => currentRevision,
  });
  const pool = new PreparedWorktreePool({
    targetSize: 1,
    dependencies,
  });
  await pool.refill();

  currentRevision = "revision-b";
  pool.reconcile();

  assert.deepEqual([...pool.worktreeIds()], []);
  assert.equal(events.at(-1), "remove:prepared-1");
});

test("fails open and removes a worktree whose preparation fails", async () => {
  const { dependencies, events } = fixtureDependencies({
    prepare: async () => {
      throw new Error("setup failed");
    },
  });
  const pool = new PreparedWorktreePool({
    targetSize: 1,
    dependencies,
  });

  await pool.refill();

  assert.equal(pool.claim(), undefined);
  assert.ok(events.includes("remove:prepared-1"));
  assert.equal(events.at(-1), "capacity:release");
});

test("coalesces concurrent refill requests", async () => {
  let finishPreparation!: () => void;
  const preparation = new Promise<void>((resolve) => {
    finishPreparation = resolve;
  });
  const { dependencies, events } = fixtureDependencies({
    prepare: () => preparation,
  });
  const pool = new PreparedWorktreePool({
    targetSize: 1,
    dependencies,
  });

  const first = pool.refill();
  const second = pool.refill();
  finishPreparation();
  await Promise.all([first, second]);

  assert.equal(
    events.filter((event) => event.startsWith("create:")).length,
    1,
  );
});

test("does not start preparation when background capacity is preempted", async () => {
  const { dependencies, events } = fixtureDependencies({
    preemptBeforeStart: true,
  });
  const pool = new PreparedWorktreePool({ targetSize: 1, dependencies });

  await pool.refill();

  assert.deepEqual(events, ["capacity:acquire", "capacity:release"]);
  assert.equal(pool.claim(), undefined);
});

test("removes partial worktrees when preparation is aborted", async () => {
  const abortController = new AbortController();
  const { dependencies, events } = fixtureDependencies({
    abortController,
    prepare: async (_path, signal) => {
      abortController.abort(new Error("foreground requested"));
      throw signal.reason;
    },
  });
  const pool = new PreparedWorktreePool({ targetSize: 1, dependencies });

  await pool.refill();

  assert.ok(events.includes("remove:prepared-1"));
  assert.ok(events.includes("capacity:preempted"));
  assert.equal(pool.claim(), undefined);
});
