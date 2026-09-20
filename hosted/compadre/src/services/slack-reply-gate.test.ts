import assert from "node:assert/strict";
import test from "node:test";
import type { SlackEvent } from "../routes/slack-events.js";
import { centralT3ThreadId } from "../t3/central-conversation.js";
import {
  SLACK_REPLY_RESPOND_THRESHOLD,
  SLACK_REPLY_SIDE_CONVERSATION_THRESHOLD,
  buildSlackReplyGateState,
  createJevSlackReplyJudge,
  decideSlackReply,
  gateUntaggedSlackReply,
  isCompadreBoundSlackThread,
  isUntaggedThreadReplyCandidate,
  type SlackReplyGateState,
  type SlackReplyJudgement,
} from "./slack-reply-gate.js";

const BOT = "UBOT";

function reply(overrides: Partial<SlackEvent> = {}): SlackEvent {
  return {
    type: "message",
    channel: "C123",
    user: "U1",
    team: "T123",
    text: "actually make the timeout 30s",
    ts: "1700000002.000100",
    thread_ts: "1700000000.000100",
    ...overrides,
  };
}

function judgement(
  overrides: Partial<SlackReplyJudgement> = {},
): SlackReplyJudgement {
  return {
    wantsAgentAction: 0.9,
    humanSideConversation: 0.1,
    model: "jev-test",
    ...overrides,
  };
}

const boundBindings = (event: SlackEvent) => ({
  async slack(threadId: string) {
    const expected = centralT3ThreadId(
      `slack:T123:${event.channel}:${event.thread_ts}`,
    );
    return threadId === expected
      ? { channelId: event.channel, threadTs: event.thread_ts! }
      : null;
  },
});

test("only untagged text replies inside channel threads are candidates", () => {
  assert.equal(isUntaggedThreadReplyCandidate(reply(), BOT), true);
  assert.equal(
    isUntaggedThreadReplyCandidate(reply({ type: "app_mention" }), BOT),
    false,
    "mentions already route",
  );
  assert.equal(
    isUntaggedThreadReplyCandidate(reply({ text: `<@${BOT}> hi` }), BOT),
    false,
    "message.channels copy of a mention already routes",
  );
  assert.equal(
    isUntaggedThreadReplyCandidate(reply({ channel: "D555" }), BOT),
    false,
    "DMs already route",
  );
  assert.equal(
    isUntaggedThreadReplyCandidate(reply({ thread_ts: undefined }), BOT),
    false,
    "top-level channel messages are never judged",
  );
  assert.equal(
    isUntaggedThreadReplyCandidate(
      reply({ thread_ts: "1700000002.000100" }),
      BOT,
    ),
    false,
    "a thread parent is not a reply",
  );
  assert.equal(
    isUntaggedThreadReplyCandidate(reply({ text: "   " }), BOT),
    false,
    "nothing to judge without text",
  );
  assert.equal(
    isUntaggedThreadReplyCandidate(reply({ bot_id: "B1" }), BOT),
    false,
  );
  assert.equal(
    isUntaggedThreadReplyCandidate(reply({ subtype: "message_changed" }), BOT),
    false,
  );
  assert.equal(
    isUntaggedThreadReplyCandidate(reply({ subtype: "file_share" }), BOT),
    true,
  );
});

test("thresholds decide respond versus ignore and side conversations win", () => {
  assert.equal(decideSlackReply(judgement()).outcome, "respond");
  assert.equal(
    decideSlackReply(
      judgement({ wantsAgentAction: SLACK_REPLY_RESPOND_THRESHOLD - 0.01 }),
    ).reason,
    "not_directed",
  );
  assert.equal(
    decideSlackReply(
      judgement({ wantsAgentAction: SLACK_REPLY_RESPOND_THRESHOLD }),
    ).outcome,
    "respond",
  );
  assert.equal(
    decideSlackReply(
      judgement({
        humanSideConversation: SLACK_REPLY_SIDE_CONVERSATION_THRESHOLD + 0.01,
      }),
    ).reason,
    "human_side_conversation",
  );
});

test("the judged state labels agent messages and excludes the reply itself", () => {
  const event = reply();
  const state = buildSlackReplyGateState({
    event,
    botUserId: BOT,
    agentIsWorking: true,
    threadMessages: [
      { ts: "1700000000.000100", user: "U1", text: `<@${BOT}> fix the flaky test` },
      { ts: "1700000001.000100", user: BOT, text: "Done, opened PR #12." },
      { ts: "1700000001.500000", bot_id: "B9", text: "posted by another bot" },
      { ts: "1700000001.700000", user: "U2", text: "   " },
      { ts: event.ts, user: "U1", text: event.text },
    ],
  });
  assert.equal(state.agent_is_working, true);
  assert.deepEqual(
    state.thread.map((message) => [message.author, message.from_agent]),
    [
      ["U1", false],
      ["Compadre", true],
      ["Compadre", true],
    ],
  );
  assert.deepEqual(state.reply, {
    author: "U1",
    text: event.text,
    has_attachments: false,
  });
});

test("long messages are clipped before they reach the judge", () => {
  const state = buildSlackReplyGateState({
    event: reply({ text: "x".repeat(5_000) }),
    agentIsWorking: false,
    threadMessages: [],
  });
  assert.equal(state.reply.text.length, 1_501);
  assert.ok(state.reply.text.endsWith("…"));
});

test("a thread is bound only when its Slack binding matches the reply", async () => {
  const event = reply();
  assert.equal(
    await isCompadreBoundSlackThread({
      bindings: boundBindings(event),
      teamId: "T123",
      channel: event.channel,
      threadTs: event.thread_ts!,
    }),
    true,
  );
  assert.equal(
    await isCompadreBoundSlackThread({
      bindings: boundBindings(event),
      teamId: "T999",
      channel: event.channel,
      threadTs: event.thread_ts!,
    }),
    false,
  );
});

test("the gate skips unbound threads without calling Slack or Jev", async () => {
  let loaded = 0;
  let judged = 0;
  const decision = await gateUntaggedSlackReply({
    event: reply({ thread_ts: "1600000000.000000" }),
    teamId: "T123",
    botUserId: BOT,
    bindings: boundBindings(reply()),
    loadThread: async () => {
      loaded += 1;
      return [];
    },
    judge: async () => {
      judged += 1;
      return judgement();
    },
  });
  assert.deepEqual(decision, { outcome: "skip", reason: "thread_not_bound" });
  assert.equal(loaded, 0);
  assert.equal(judged, 0);
});

test("the gate passes thread context and running state to the judge", async () => {
  const event = reply();
  const t3ThreadId = centralT3ThreadId(`slack:T123:C123:${event.thread_ts}`);
  let seen: SlackReplyGateState | undefined;
  const decision = await gateUntaggedSlackReply({
    event,
    teamId: "T123",
    botUserId: BOT,
    bindings: boundBindings(event),
    centralClient: {
      async snapshot() {
        return {
          threads: [
            { id: t3ThreadId, latestTurn: { state: "running" } },
            { id: "other", latestTurn: { state: "completed" } },
          ],
        } as never;
      },
    },
    loadThread: async ({ channel, threadTs }) => {
      assert.equal(channel, "C123");
      assert.equal(threadTs, event.thread_ts);
      return [
        { ts: event.thread_ts!, user: "U1", text: `<@${BOT}> fix it` },
        { ts: event.ts, user: "U1", text: event.text },
      ];
    },
    judge: async (state) => {
      seen = state;
      return judgement();
    },
  });
  assert.equal(decision.outcome, "respond");
  assert.equal(seen?.agent_is_working, true);
  assert.equal(seen?.thread.length, 1);
});

test("judge and Slack failures fail closed as ignore", async () => {
  const event = reply();
  const failedJudge = await gateUntaggedSlackReply({
    event,
    teamId: "T123",
    bindings: boundBindings(event),
    loadThread: async () => [],
    judge: async () => {
      throw new Error("typesafe unavailable");
    },
  });
  assert.deepEqual(failedJudge, { outcome: "ignore", reason: "judge_failed" });

  const failedSlack = await gateUntaggedSlackReply({
    event,
    teamId: "T123",
    bindings: boundBindings(event),
    loadThread: async () => {
      throw new Error("conversations.replies failed: ratelimited");
    },
    judge: async () => judgement(),
  });
  assert.deepEqual(failedSlack, { outcome: "ignore", reason: "judge_failed" });
});

test("the Jev judge reads both noul answers from one request", async () => {
  let questionKeys: string[] = [];
  const judge = createJevSlackReplyJudge({
    systemOne(request) {
      questionKeys = Object.keys(request.questions);
      return Promise.resolve({
        model: "jev-1.13.0",
        answers: {
          wants_agent_action: { type: "noul", noul: 0.87 },
          human_side_conversation: { type: "noul", noul: 0.12 },
        },
        usage: { input_tokens: 300, output_tokens: 20 },
      }) as never;
    },
  });
  const result = await judge(
    buildSlackReplyGateState({
      event: reply(),
      agentIsWorking: false,
      threadMessages: [],
    }),
  );
  assert.deepEqual(questionKeys.sort(), [
    "human_side_conversation",
    "wants_agent_action",
  ]);
  assert.equal(result.wantsAgentAction, 0.87);
  assert.equal(result.humanSideConversation, 0.12);
  assert.equal(result.model, "jev-1.13.0");
  assert.equal(result.usage?.input_tokens, 300);
});
