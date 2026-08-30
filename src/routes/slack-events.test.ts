import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  isAllowedSlackWorkspace,
  isSupportedUserMessage,
  resolveSlackBotUserId,
  slackMessageTextForAgent,
  slackEventsRoutes,
  stripSlackBotMention,
  type SlackEvent,
} from "./slack-events.js";

test("allows Slack events only from the configured workspace", () => {
  assert.equal(
    isAllowedSlackWorkspace({
      configuredWorkspaceId: "T123",
      eventWorkspaceId: "T123",
    }),
    true,
  );
  assert.equal(
    isAllowedSlackWorkspace({
      configuredWorkspaceId: "T123",
      eventWorkspaceId: "T999",
    }),
    false,
  );
  assert.equal(
    isAllowedSlackWorkspace({
      configuredWorkspaceId: "T123",
    }),
    false,
  );
  assert.equal(
    isAllowedSlackWorkspace({
      eventWorkspaceId: "T123",
    }),
    false,
  );
});

test("rejects a validly signed event callback from another workspace", async () => {
  const signingSecret = "test-signing-secret";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    type: "event_callback",
    team_id: "T999",
    event: {},
  });
  const signature = `v0=${crypto
    .createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  const previousSigningSecret = process.env.SLACK_SIGNING_SECRET;
  const previousWorkspaceId = process.env.COMPADRE_SLACK_WORKSPACE_ID;
  process.env.SLACK_SIGNING_SECRET = signingSecret;
  process.env.COMPADRE_SLACK_WORKSPACE_ID = "T123";

  try {
    const response = await slackEventsRoutes.request(
      "https://controller.example/slack/events",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": signature,
        },
        body,
      },
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "workspace not allowed" });
  } finally {
    if (previousSigningSecret === undefined) {
      delete process.env.SLACK_SIGNING_SECRET;
    } else {
      process.env.SLACK_SIGNING_SECRET = previousSigningSecret;
    }
    if (previousWorkspaceId === undefined) {
      delete process.env.COMPADRE_SLACK_WORKSPACE_ID;
    } else {
      process.env.COMPADRE_SLACK_WORKSPACE_ID = previousWorkspaceId;
    }
  }
});

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

test("a mention-only thread reply asks the agent to answer preceding context", () => {
  assert.equal(
    slackMessageTextForAgent({
      messageText: "",
      isThreadReply: true,
      mentionsBot: true,
    }),
    "Respond to the preceding Slack message.",
  );
  assert.equal(
    slackMessageTextForAgent({
      messageText: "",
      isThreadReply: false,
      mentionsBot: true,
    }),
    "",
  );
});
