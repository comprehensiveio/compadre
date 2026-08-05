import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InMemoryHarnessThreadStore,
  resumableHarnessSession,
} from "./thread-state.js";

test("shares a worktree while keeping provider sessions separate", async () => {
  const store = new InMemoryHarnessThreadStore();
  let allocations = 0;
  const createWorktreeId = () => `worktree-${++allocations}`;
  const first = await store.getOrCreate("thread-1", createWorktreeId);
  await store.recordSession(
    "thread-1",
    "claude-code",
    "claude-session",
    first.worktreeId
  );

  const second = await store.getOrCreate("thread-1", createWorktreeId);
  assert.equal(allocations, 1);
  assert.equal(second.worktreeId, first.worktreeId);
  assert.equal(second.sessions["claude-code"], "claude-session");
  assert.equal(second.sessions.codex, undefined);
  assert.equal(
    resumableHarnessSession(second, "claude-code"),
    "claude-session"
  );

  await store.recordSession(
    "thread-1",
    "codex",
    "codex-session",
    first.worktreeId
  );
  assert.equal(second.sessions.codex, "codex-session");
  assert.equal(resumableHarnessSession(second, "codex"), "codex-session");
  assert.equal(resumableHarnessSession(second, "claude-code"), undefined);
});

test("only removes a failed thread before any provider establishes a session", async () => {
  const store = new InMemoryHarnessThreadStore();
  const empty = await store.getOrCreate("empty", () => "worktree-empty");
  assert.equal(
    await store.deleteIfUninitialized("empty", empty.worktreeId),
    true
  );

  const active = await store.getOrCreate("active", () => "worktree-active");
  await store.recordSession(
    "active",
    "claude-code",
    "claude-session",
    active.worktreeId
  );
  assert.equal(
    await store.deleteIfUninitialized("active", active.worktreeId),
    false
  );
});

test("deletes an initialized thread for explicit lifecycle cleanup", async () => {
  const store = new InMemoryHarnessThreadStore();
  await store.getOrCreate("thread", () => "worktree");
  await store.recordSession("thread", "codex", "session", "worktree");

  const deleted = await store.delete("thread");

  assert.equal(deleted?.worktreeId, "worktree");
  assert.deepEqual(deleted?.sessions, { codex: "session" });
  assert.deepEqual(deleted?.transcript, []);
  assert.equal(deleted?.lastProvider, "codex");
  assert.equal(await store.delete("thread"), undefined);
});

test("retains a bounded provider-neutral transcript", async () => {
  const store = new InMemoryHarnessThreadStore();
  await store.getOrCreate("thread", () => "worktree");
  for (let index = 0; index < 101; index += 1) {
    await store.recordTurn(
      "thread",
      `user-${index}`,
      `assistant-${index}`,
      "worktree"
    );
  }

  const state = await store.delete("thread");
  assert.equal(state?.transcript.length, 200);
  assert.deepEqual(state?.transcript[0], {
    role: "user",
    content: "user-1",
  });
  assert.deepEqual(state?.transcript.at(-1), {
    role: "assistant",
    content: "assistant-100",
  });
});

test("expires thread state and its worktree ownership together", async () => {
  let now = 1_000;
  const store = new InMemoryHarnessThreadStore(() => now);
  await store.getOrCreate("stale", () => "worktree-stale");
  await store.getOrCreate("active", () => "worktree-active");

  now = 1_500;
  await store.getOrCreate("active", () => "unused");
  now = 2_100;

  const expired = await store.deleteStale(1_000);

  assert.deepEqual(expired.map((state) => state.worktreeId), ["worktree-stale"]);
  assert.deepEqual(
    [...(await store.worktreeIds())],
    ["worktree-active"]
  );
});
