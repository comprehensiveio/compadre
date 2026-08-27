import assert from "node:assert/strict";
import test from "node:test";
import {
  isSupportedUserMessage,
  resolveSlackBotUserId,
  stripSlackBotMention,
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

test("accepts Slack app_mention events", () => {
  assert.equal(
    isSupportedUserMessage(message({ type: "app_mention", subtype: undefined })),
    true,
  );
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

test("resolves the bot user id from configuration, event authorization, or mention", () => {
  assert.equal(
    resolveSlackBotUserId({
      configured: "UCONFIGURED",
      authorizations: [{ user_id: "UAUTHORIZED", is_bot: true }],
    }),
    "UCONFIGURED",
  );
  assert.equal(
    resolveSlackBotUserId({
      authorizations: [{ user_id: "UAUTHORIZED", is_bot: true }],
    }),
    "UAUTHORIZED",
  );
  assert.equal(
    resolveSlackBotUserId({
      event: message({ type: "app_mention", text: "<@UMENTIONED> hello" }),
    }),
    "UMENTIONED",
  );
});

test("strips only this installation's bot mention", () => {
  assert.equal(
    stripSlackBotMention("<@UNEWBOT> hello <@UOTHER>", "UNEWBOT"),
    "hello <@UOTHER>",
  );
});
