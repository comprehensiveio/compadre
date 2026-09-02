import assert from "node:assert/strict";
import test from "node:test";
import { humanizeToolName } from "./tool-labels.js";

test("normalizes T3 lifecycle summaries into active Slack status labels", () => {
  assert.equal(humanizeToolName("Ran command"), "Running command");
  assert.equal(humanizeToolName("Read file"), "Reading file");
  assert.equal(humanizeToolName("Changed files"), "Changing files");
  assert.equal(humanizeToolName("Searched files"), "Searching files");
});
