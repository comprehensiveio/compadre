import assert from "node:assert/strict";
import test from "node:test";
import { resolveSlackMessageAttribution } from "./slack-user-attribution.js";
import type { UserDirectory } from "./user-directory.js";

test("provisions the Slack identity and returns message attribution", async () => {
  const upserts: unknown[] = [];
  const directory = {
    async upsertSlackIdentity(input: unknown) {
      upserts.push(input);
      return {
        id: "ce726d9e-e526-5c56-aa95-7c8101ec2f78",
        displayName: "Isaac",
        avatarUrl: "https://avatars.slack-edge.com/isaac.png",
      };
    },
  } as unknown as UserDirectory;
  const fetchImpl = (async () =>
    Response.json({
      ok: true,
      user: {
        id: "U123",
        profile: {
          display_name: "Isaac",
          image_192: "https://avatars.slack-edge.com/isaac.png",
        },
      },
    })) as typeof fetch;

  const attribution = await resolveSlackMessageAttribution({
    directory,
    botToken: "xoxb-test",
    workspaceId: "T123",
    slackUserId: "U123",
    channelId: "C123",
    messageTs: "123.456",
    fetchImpl,
  });

  assert.deepEqual(upserts, [
    {
      workspaceId: "T123",
      slackUserId: "U123",
      displayName: "Isaac",
      avatarUrl: "https://avatars.slack-edge.com/isaac.png",
    },
  ]);
  assert.deepEqual(attribution, {
    userId: "ce726d9e-e526-5c56-aa95-7c8101ec2f78",
    displayName: "Isaac",
    avatarUrl: "https://avatars.slack-edge.com/isaac.png",
    origin: "slack",
    slack: {
      workspaceId: "T123",
      userId: "U123",
      channelId: "C123",
      messageTs: "123.456",
    },
  });
});

test("does not make identity authoritative without the required trusted inputs", async () => {
  assert.equal(
    await resolveSlackMessageAttribution({
      directory: null,
      botToken: "xoxb-test",
      workspaceId: "T123",
      slackUserId: "U123",
      channelId: "C123",
      messageTs: "123.456",
    }),
    undefined,
  );
});
