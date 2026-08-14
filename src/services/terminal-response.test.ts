import assert from "node:assert/strict";
import test from "node:test";
import { TerminalResponseTracker } from "./terminal-response.js";

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

test("accepts text-only runs whose provider omits a finish reason", () => {
  const tracker = new TerminalResponseTracker();
  tracker.recordText("A complete answer");
  assert.equal(
    tracker.isComplete({ result: "A complete answer", finishReason: null }),
    true,
  );
});
