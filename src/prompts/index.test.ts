import assert from "node:assert/strict";
import test from "node:test";
import {
  getBaseSystemPrompt,
  getSlackStreamingSystemPrompt,
  getSlackSystemPrompt,
} from "./index.js";

test("keeps Slack workspace persistence and upload instructions scoped to Slack prompts", () => {
  const basePrompt = getBaseSystemPrompt("/tmp/test-repo");
  const slackPrompts = [
    getSlackSystemPrompt("/tmp/test-repo"),
    getSlackStreamingSystemPrompt("/tmp/test-repo"),
  ];

  assert.doesNotMatch(basePrompt, /## Slack file uploads/);
  assert.doesNotMatch(basePrompt, /## Workspace persistence between Slack messages/);
  assert.match(basePrompt, /standard Markdown/);
  assert.match(basePrompt, /slack_upload_file/);
  for (const prompt of slackPrompts) {
    assert.match(prompt, /local workspace is temporary/);
    assert.match(prompt, /commit and push them/);
    assert.match(prompt, /Never commit or push secrets/);
    assert.match(prompt, /stop without pushing/);
    assert.match(prompt, /upload the meaningful output to the current Slack thread/);
    assert.match(prompt, /cannot safely preserve required work/);
    assert.match(prompt, /Do not upload secrets/);
    assert.match(prompt, /Prefer an inline Markdown table/);
    assert.match(prompt, /explicitly asks for one/);
    assert.match(prompt, /slack_upload_file/);
    assert.match(prompt, /slack_watch_comp_pr_deployment/);
    assert.match(prompt, /Do not merely promise to follow up/);
    assert.match(prompt, /find the PR for this/);
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

test("teaches harnesses to prepare dependencies only when needed", () => {
  const prompt = getBaseSystemPrompt("/tmp/test-repo");

  assert.match(prompt, /worktree may intentionally start before dependencies/);
  assert.match(prompt, /scripts\/worktree-up\.sh --hook/);
  assert.match(prompt, /Reading, searching, editing, and git do not require setup/);
});
