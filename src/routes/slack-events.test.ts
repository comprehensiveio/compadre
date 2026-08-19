import assert from "node:assert/strict";
import test from "node:test";
import {
  isSupportedUserMessage,
  type SlackEvent,
} from "./slack-events.js";

function message(overrides: Partial<SlackEvent> = {}): SlackEvent {
  return {
    type: "message",
    channel: "C123",
    user: "U123",
    text: "<@U073509NYP7> what is in this screenshot?",
    ts: "1787167659.834189",
    ...overrides,
  };
}

test("accepts a user message with a file attachment", () => {
  assert.equal(
    isSupportedUserMessage(message({
      subtype: "file_share",
      files: [{ id: "F123", name: "screenshot.png", mimetype: "image/png" }],
    })),
    true,
  );
});

test("accepts an ordinary user message", () => {
  assert.equal(isSupportedUserMessage(message()), true);
});

test("rejects bot and non-user message subtypes", () => {
  assert.equal(isSupportedUserMessage(message({ bot_id: "B123" })), false);
  assert.equal(
    isSupportedUserMessage(message({ subtype: "message_changed" })),
    false,
  );
  assert.equal(
    isSupportedUserMessage(message({ subtype: "channel_join" })),
    false,
  );
});
