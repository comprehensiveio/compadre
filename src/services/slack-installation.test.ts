import assert from "node:assert/strict";
import test from "node:test";
import {
  isAllowedSlackApp,
  validateSlackInstallation,
} from "./slack-installation.js";

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("validates the Slack token against the configured workspace and bot", async () => {
  let requests = 0;
  const identity = await validateSlackInstallation({
    botToken: "xoxb-test",
    expectedWorkspaceId: "T123",
    expectedBotUserId: "U123",
    expectedAppId: "A123",
    fetchImpl: async (input) => {
      requests += 1;
      return String(input).includes("bots.info")
        ? response({ ok: true, bot: { app_id: "A123" } })
        : response({
            ok: true,
            team_id: "T123",
            user_id: "U123",
            bot_id: "B123",
          });
    },
  });
  assert.deepEqual(identity, {
    workspaceId: "T123",
    botUserId: "U123",
    botId: "B123",
    appId: "A123",
  });
  assert.equal(requests, 2);
});

test("rejects a bot token from another Slack app", async () => {
  await assert.rejects(
    validateSlackInstallation({
      botToken: "xoxb-test",
      expectedWorkspaceId: "T123",
      expectedAppId: "A123",
      fetchImpl: async (input) =>
        String(input).includes("bots.info")
          ? response({ ok: true, bot: { app_id: "A999" } })
          : response({
              ok: true,
              team_id: "T123",
              user_id: "U123",
              bot_id: "B123",
            }),
    }),
    /app A999, expected A123/,
  );
});

test("rejects a valid token from another Slack workspace", async () => {
  await assert.rejects(
    validateSlackInstallation({
      botToken: "xoxb-wrong-workspace",
      expectedWorkspaceId: "T123",
      fetchImpl: async () =>
        response({ ok: true, team_id: "T999", user_id: "U999" }),
    }),
    /workspace T999, expected T123/,
  );
});

test("pins signed events to the configured Slack app id", () => {
  assert.equal(
    isAllowedSlackApp({ configuredAppId: "A123", eventAppId: "A123" }),
    true,
  );
  assert.equal(
    isAllowedSlackApp({ configuredAppId: "A123", eventAppId: "A999" }),
    false,
  );
  assert.equal(isAllowedSlackApp({ eventAppId: "A999" }), true);
});
