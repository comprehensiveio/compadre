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

  assert.doesNotMatch(basePrompt, /## Slack file uploads/);
  assert.match(basePrompt, /standard Markdown/);
  assert.match(basePrompt, /slack_upload_file/);
  for (const prompt of slackPrompts) {
    assert.match(prompt, /Prefer an inline Markdown table/);
    assert.match(prompt, /explicitly asks for one/);
    assert.match(prompt, /slack_upload_file/);
    assert.doesNotMatch(prompt, /curl/);
  }
});
