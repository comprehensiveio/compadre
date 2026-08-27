import assert from "node:assert/strict";
import test from "node:test";
import {
  slackBackedUserId,
  slackIdentityFromUserInfo,
  slackMessageAttribution,
} from "./user-directory.js";

test("decodes stable Slack profile attribution", () => {
  assert.deepEqual(
    slackIdentityFromUserInfo({
      ok: true,
      user: {
        name: "isaac",
        real_name: "Isaac Sherrill",
        profile: {
          display_name: "Isaac",
          real_name: "Isaac Sherrill",
          image_192: "https://avatars.slack-edge.com/isaac.png",
          email: "isaac@example.com",
        },
      },
    }),
    {
      displayName: "Isaac",
      realName: "Isaac Sherrill",
      avatarUrl: "https://avatars.slack-edge.com/isaac.png",
      email: "isaac@example.com",
    },
  );
});

test("falls back safely when Slack profile fields are sparse", () => {
  assert.deepEqual(
    slackIdentityFromUserInfo({ user: { name: "isaac", profile: {} } }),
    { displayName: "isaac" },
  );
  assert.deepEqual(slackIdentityFromUserInfo({}), { displayName: "Slack user" });
});

test("uses a stable UUID and creates Slack message attribution", () => {
  const first = slackBackedUserId("T123", "U123");
  assert.equal(first, slackBackedUserId("T123", "U123"));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first, slackBackedUserId("T999", "U123"));

  assert.deepEqual(
    slackMessageAttribution({
      user: {
        id: first,
        displayName: "Isaac",
        avatarUrl: "https://example.com/avatar.png",
      },
      workspaceId: "T123",
      slackUserId: "U123",
      channelId: "C123",
      messageTs: "123.456",
    }),
    {
      userId: first,
      displayName: "Isaac",
      avatarUrl: "https://example.com/avatar.png",
      origin: "slack",
      slack: {
        workspaceId: "T123",
        userId: "U123",
        channelId: "C123",
        messageTs: "123.456",
      },
    },
  );
});
