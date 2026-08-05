import assert from "node:assert/strict";
import test from "node:test";
import { isRemovableStaleWorktree } from "./repo.js";

test("removes only stale worktrees that have no live thread owner", () => {
  const retained = new Set(["active"]);
  const now = 10_000;

  assert.equal(
    isRemovableStaleWorktree("orphan", 1_000, now, 5_000, retained),
    true
  );
  assert.equal(
    isRemovableStaleWorktree("active", 1_000, now, 5_000, retained),
    false
  );
  assert.equal(
    isRemovableStaleWorktree("recent", 9_000, now, 5_000, retained),
    false
  );
});
