import assert from "node:assert/strict";
import test from "node:test";
import {
  getBaseSystemPrompt,
  getSlackStreamingSystemPrompt,
  getSlackSystemPrompt,
} from "./index.js";

test("keeps Slack upload instructions scoped to Slack prompts", () => {
  const basePrompt = getBaseSystemPrompt("/tmp/test-repo");
  const slackPrompts = [
    getSlackSystemPrompt("/tmp/test-repo"),
    getSlackStreamingSystemPrompt("/tmp/test-repo"),
  ];

  assert.doesNotMatch(basePrompt, /Slack file uploads/);
  for (const prompt of slackPrompts) {
    assert.match(prompt, /Prefer an inline Markdown table/);
    assert.match(prompt, /explicitly asks for one/);
    assert.match(prompt, /files\.getUploadURLExternal/);
    assert.match(prompt, /files\.completeUploadExternal/);
    assert.match(prompt, /"thread_ts":"THREAD_TS"/);
  }
});
