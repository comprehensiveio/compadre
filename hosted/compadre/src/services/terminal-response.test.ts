import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_FAILURE_NOTICE,
  INCOMPLETE_RESPONSE_NOTICE,
  IncompleteTerminalResponseError,
  MODAL_SPEND_LIMIT_NOTICE,
  TerminalResponseTracker,
  slackFailureNotice,
} from "./terminal-response.js";

test("rejects empty and preamble-only runs", () => {
  const empty = new TerminalResponseTracker();
  assert.equal(empty.isComplete({ result: "", finishReason: "stop" }), false);

  const preamble = new TerminalResponseTracker();
  preamble.recordText("I'll investigate this now.");
  preamble.recordToolStart();
  assert.equal(
    preamble.isComplete({
      result: "I'll investigate this now.",
      finishReason: "stop",
    }),
    false,
  );

  preamble.recordText("   \n");
  assert.equal(
    preamble.isComplete({
      result: "I'll investigate this now.",
      finishReason: "stop",
    }),
    false,
  );
});

test("accepts a final answer after the last tool action", () => {
  const tracker = new TerminalResponseTracker();
  tracker.recordText("I'm checking that.");
  tracker.recordToolStart();
  tracker.recordText("Here is what I found.");

  assert.equal(
    tracker.isComplete({
      result: "I'm checking that.\n\nHere is what I found.",
      finishReason: "stop",
    }),
    true,
  );
});

test("rejects non-terminal finish reasons even when answer text exists", () => {
  for (const finishReason of [
    "length",
    "content_filter",
    "tool_calls",
  ] as const) {
    const tracker = new TerminalResponseTracker();
    tracker.recordText("A partial answer");
    assert.equal(
      tracker.isComplete({ result: "A partial answer", finishReason }),
      false,
    );
  }
});

test("rejects a response whose Slack delivery was truncated", () => {
  const tracker = new TerminalResponseTracker();
  tracker.recordText("A complete answer that did not all reach Slack");
  assert.equal(
    tracker.isComplete(
      {
        result: "A complete answer that did not all reach Slack",
        finishReason: "stop",
      },
      { truncated: true },
    ),
    false,
  );
});

test("accepts text-only runs whose provider omits a finish reason", () => {
  const tracker = new TerminalResponseTracker();
  tracker.recordText("A complete answer");
  assert.equal(
    tracker.isComplete({ result: "A complete answer", finishReason: null }),
    true,
  );
});

test("selects a sanitized Slack notice for incomplete and thrown failures", () => {
  assert.equal(
    slackFailureNotice(new IncompleteTerminalResponseError("length")),
    INCOMPLETE_RESPONSE_NOTICE,
  );
  assert.equal(
    slackFailureNotice(new Error("secret provider detail")),
    AGENT_FAILURE_NOTICE,
  );
  assert.doesNotMatch(AGENT_FAILURE_NOTICE, /secret provider detail/);
});

test("explains Modal spend-limit failures without exposing workspace details", () => {
  const error = new Error("Activity task failed", {
    cause: {
      details:
        "Workspace ac-sensitive has exceeded its spend limit",
    },
  });

  assert.equal(slackFailureNotice(error), MODAL_SPEND_LIMIT_NOTICE);
  assert.match(MODAL_SPEND_LIMIT_NOTICE, /Modal workspace.*spend limit/i);
  assert.doesNotMatch(MODAL_SPEND_LIMIT_NOTICE, /ac-sensitive/);
  assert.equal(
    slackFailureNotice(new Error("RESOURCE_EXHAUSTED: concurrency limit")),
    AGENT_FAILURE_NOTICE,
  );
});

test("explains known failures in one sentence without echoing raw details", () => {
  const cases = [
    ["Event delivery is blocked. Agent work may have completed or may still be running; its latest output has not been synchronized. Delivery requires recovery.", /recover delivery/],
    ["context_length_exceeded", /context limit/],
    ["rate_limit_exceeded", /rate limit/],
    ["Incorrect API key provided: sk-private", /authentication failed/],
    ["Request entity too large", /size limit/],
    ["The operation timed out", /timeout/],
    ["The agent run completed without a final response.", /before finishing/],
  ] as const;
  for (const [message, expected] of cases) {
    const notice = slackFailureNotice(new Error(`${message}\nsecret payload <@U123> https://private.example`));
    assert.match(notice, expected);
    assert.doesNotMatch(notice, /secret|sk-private|U123|https:|\n/);
    assert.equal(notice.match(/[.!?](?:\s|$)/g)?.length, 1);
    assert.ok(notice.length < 200);
  }
});

test("preserves uncertainty about blocked delivery and prioritizes it over timeout", () => {
  const notice = slackFailureNotice(new Error("Activity timed out", {
    cause: { message: "Event delivery is blocked." },
  }));
  assert.match(notice, /recover delivery/);
  assert.doesNotMatch(notice, /finished|completed|saved|@Compadre continue/);
});

test("handles wrapped errors and cyclic causes with a short unknown fallback", () => {
  const error = new Error("opaque failure");
  error.cause = error;
  assert.equal(slackFailureNotice(error), AGENT_FAILURE_NOTICE);
  assert.equal(slackFailureNotice(null), AGENT_FAILURE_NOTICE);
  assert.match(slackFailureNotice({ message: "Activity failed", cause: { message: "rate_limit_exceeded" } }), /rate limit/);
});
