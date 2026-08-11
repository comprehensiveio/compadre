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

test("applies the concise response contract to every harness prompt", () => {
  const prompts = [
    getBaseSystemPrompt("/tmp/test-repo"),
    getSlackSystemPrompt("/tmp/test-repo"),
    getSlackStreamingSystemPrompt("/tmp/test-repo"),
  ];

  for (const prompt of prompts) {
    assert.match(prompt, /Lead with the outcome or conclusion/);
    assert.match(prompt, /smallest complete answer/);
    assert.match(prompt, /result, files changed, verification/);
    assert.match(prompt, /Do not add a preamble/);
    assert.match(prompt, /at most five bullets/);
    assert.match(prompt, /Keep progress updates to one short sentence/);
    assert.match(prompt, /correctness, safety, or a decision requires it/);
  }
});
