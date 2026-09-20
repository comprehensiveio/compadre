import assert from "node:assert/strict";
import test from "node:test";
import {
  markSlackThreadContinuedInUi,
  UI_CONTINUATION_REACTION,
} from "./slack-ui-continuation.js";

function client(input: {
  pages: Array<Record<string, unknown>>;
  botUserId?: string;
  reactionError?: Error;
}) {
  const reactions: Array<{ channel: string; timestamp: string; reaction: string }> = [];
  const cursors: Array<string | undefined> = [];
  return {
    reactions,
    cursors,
    value: {
      async getAuthIdentity() {
        return { ok: true, user_id: input.botUserId ?? "UCOMPADRE" };
      },
      async getThreadReplies(
        _channel: string,
        _threadTs: string,
        _limit?: number,
        cursor?: string,
      ) {
        cursors.push(cursor);
        return input.pages.shift() ?? { ok: true, messages: [] };
      },
      async addReaction(channel: string, timestamp: string, reaction: string) {
        reactions.push({ channel, timestamp, reaction });
        if (input.reactionError) throw input.reactionError;
        return { ok: true };
      },
    },
  };
}

test("reacts to the most recent Compadre message before the UI continuation", async () => {
  const slack = client({
    pages: [
      {
        ok: true,
        messages: [
          { ts: "100.001", user: "UCOMPADRE" },
          { ts: "101.001", user: "UHUMAN" },
        ],
        response_metadata: { next_cursor: "next-page" },
      },
      {
        ok: true,
        messages: [
          { ts: "102.001", user: "UCOMPADRE" },
          { ts: "104.001", user: "UCOMPADRE" },
        ],
        response_metadata: { next_cursor: "" },
      },
    ],
  });

  const marked = await markSlackThreadContinuedInUi({
    client: slack.value,
    binding: { channelId: "C1", threadTs: "100.000" },
    beforeMs: 103_000,
  });

  assert.equal(marked, "102.001");
  assert.deepEqual(slack.cursors, [undefined, "next-page"]);
  assert.deepEqual(slack.reactions, [{
    channel: "C1",
    timestamp: "102.001",
    reaction: UI_CONTINUATION_REACTION,
  }]);
});

test("does nothing when the thread has no earlier Compadre message", async () => {
  const slack = client({
    pages: [{
      ok: true,
      messages: [
        { ts: "100.001", user: "UHUMAN" },
        { ts: "104.001", user: "UCOMPADRE" },
      ],
    }],
  });

  assert.equal(await markSlackThreadContinuedInUi({
    client: slack.value,
    binding: { channelId: "C1", threadTs: "100.000" },
    beforeMs: 103_000,
    botUserId: "UCOMPADRE",
  }), null);
  assert.deepEqual(slack.reactions, []);
});

test("treats an existing UI-continuation reaction as success", async () => {
  const slack = client({
    pages: [{ messages: [{ ts: "100.001", user: "UCOMPADRE" }] }],
    reactionError: new Error("Slack reactions.add failed: already_reacted"),
  });

  assert.equal(await markSlackThreadContinuedInUi({
    client: slack.value,
    binding: { channelId: "C1", threadTs: "100.000" },
    beforeMs: 101_000,
  }), "100.001");
});
