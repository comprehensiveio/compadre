import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  durableSlackEventKey,
  isAiRoutableSlackEvent,
  slackEventsRoutes,
  type SlackEvent,
} from "../routes/slack-events.js";
import {
  createSlackInboxProcessor,
  setConfiguredSlackInbox,
} from "./slack-inbox.js";
import type { SlackInboxEvent, SlackInboxStore } from "./slack-inbox-store.js";

function slackEvent(overrides: Partial<SlackEvent> = {}): SlackEvent {
  return {
    type: "app_mention",
    channel: "C123",
    user: "U123",
    text: "<@UBOT> do the thing",
    ts: "1788250000.000100",
    team: "T123",
    ...overrides,
  };
}

function inboxRow(event: SlackEvent, attempts = 1): SlackInboxEvent {
  return {
    eventKey: durableSlackEventKey(event, "T123"),
    teamId: "T123",
    botUserId: "UBOT",
    event,
    status: "processing",
    attempts,
    nextAttemptAt: new Date(),
    claimedAt: new Date(),
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

interface FakeStoreState {
  claims: SlackInboxEvent[];
  done: string[];
  failed: Array<{ eventKey: string; error: string }>;
}

function fakeStore(rows: SlackInboxEvent[]): {
  store: SlackInboxStore;
  state: FakeStoreState;
} {
  const pending = [...rows];
  const state: FakeStoreState = { claims: [], done: [], failed: [] };
  const store = {
    async enqueue() {
      return true;
    },
    async claimNext() {
      const row = pending.shift() ?? null;
      if (row) state.claims.push(row);
      return row;
    },
    async renewClaim() {
      return true;
    },
    async markDone(eventKey: string) {
      state.done.push(eventKey);
    },
    async markFailed(
      row: Pick<SlackInboxEvent, "eventKey">,
      error: unknown,
    ) {
      state.failed.push({ eventKey: row.eventKey, error: String(error) });
    },
  } as unknown as SlackInboxStore;
  return { store, state };
}

test("classifies AI-routable events and keys duplicates together", () => {
  assert.equal(isAiRoutableSlackEvent(slackEvent(), "UBOT"), true);
  assert.equal(
    isAiRoutableSlackEvent(
      slackEvent({ type: "message", text: "<@UBOT> hi" }),
      "UBOT",
    ),
    true,
    "channel message mentioning the bot is routable",
  );
  assert.equal(
    isAiRoutableSlackEvent(
      slackEvent({ type: "message", text: "no mention here" }),
      "UBOT",
    ),
    false,
    "bare channel chatter is not persisted",
  );
  assert.equal(
    isAiRoutableSlackEvent(
      slackEvent({ type: "message", channel: "D999", text: "direct" }),
      "UBOT",
    ),
    true,
    "DMs are routable without a mention",
  );
  assert.equal(
    isAiRoutableSlackEvent(slackEvent({ bot_id: "B1" }), "UBOT"),
    false,
    "bot echoes are never routable",
  );
  // Slack delivers one mention as both app_mention and message.channels with
  // different event_ids; the durable key must collapse them.
  assert.equal(
    durableSlackEventKey(slackEvent({ type: "app_mention" }), "T123"),
    durableSlackEventKey(slackEvent({ type: "message" }), "T123"),
  );
});

test("the processor settles rows at durable dispatch, not at routing end", async () => {
  const event = slackEvent();
  const { store, state } = fakeStore([inboxRow(event)]);
  let resolveTail: (() => void) | undefined;
  const process = createSlackInboxProcessor({
    store,
    route: async (routedEvent, teamId, botUserId, hooks) => {
      assert.equal(routedEvent.ts, event.ts);
      assert.equal(teamId, "T123");
      assert.equal(botUserId, "UBOT");
      await hooks.onDurablyDispatched();
      // The post-dispatch tail (delivery watch) may run for minutes; the row
      // must already be settled before it finishes.
      assert.deepEqual(state.done, [durableSlackEventKey(event, "T123")]);
      await new Promise<void>((resolve) => {
        resolveTail = resolve;
      });
    },
  });
  const processing = process();
  while (!resolveTail) await new Promise((resolve) => setImmediate(resolve));
  resolveTail();
  await processing;
  assert.equal(state.done.length, 1, "done exactly once");
  assert.equal(state.failed.length, 0);
});

test("a routing failure before dispatch requeues the row", async () => {
  const event = slackEvent();
  const { store, state } = fakeStore([inboxRow(event, 2)]);
  const process = createSlackInboxProcessor({
    store,
    route: async () => {
      throw new Error("attribution lookup failed");
    },
  });
  await process();
  assert.equal(state.done.length, 0);
  assert.equal(state.failed.length, 1);
  assert.match(state.failed[0]!.error, /attribution lookup failed/);
});

test("a route that finishes without dispatching consumes the row", async () => {
  const event = slackEvent();
  const { store, state } = fakeStore([inboxRow(event)]);
  const process = createSlackInboxProcessor({
    store,
    route: async () => undefined,
  });
  await process();
  assert.deepEqual(state.done, [durableSlackEventKey(event, "T123")]);
});

test("the events route persists an AI-routable event before acknowledging", async (t) => {
  const signingSecret = "test-signing-secret";
  const previousSigningSecret = process.env.SLACK_SIGNING_SECRET;
  const previousWorkspaceId = process.env.COMPADRE_SLACK_WORKSPACE_ID;
  process.env.SLACK_SIGNING_SECRET = signingSecret;
  process.env.COMPADRE_SLACK_WORKSPACE_ID = "T123";
  const enqueued: Array<{ eventKey: string; event: SlackEvent }> = [];
  let pokes = 0;
  let failEnqueue = false;
  setConfiguredSlackInbox({
    store: {
      async enqueue(input: { eventKey: string; event: SlackEvent }) {
        if (failEnqueue) throw new Error("database offline");
        enqueued.push({ eventKey: input.eventKey, event: input.event });
        return true;
      },
    } as unknown as SlackInboxStore,
    poke: () => {
      pokes += 1;
    },
  });
  t.after(() => {
    setConfiguredSlackInbox(undefined);
    if (previousSigningSecret === undefined) {
      delete process.env.SLACK_SIGNING_SECRET;
    } else process.env.SLACK_SIGNING_SECRET = previousSigningSecret;
    if (previousWorkspaceId === undefined) {
      delete process.env.COMPADRE_SLACK_WORKSPACE_ID;
    } else process.env.COMPADRE_SLACK_WORKSPACE_ID = previousWorkspaceId;
  });

  const send = async (ts: string) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T123",
      event_id: `Ev${ts}`,
      event: slackEvent({ ts }),
    });
    const signature = `v0=${crypto
      .createHmac("sha256", signingSecret)
      .update(`v0:${timestamp}:${body}`)
      .digest("hex")}`;
    return slackEventsRoutes.request("https://controller.example/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body,
    });
  };

  const response = await send("1788250001.000200");
  assert.equal(response.status, 200);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0]?.eventKey, "T123:C123:1788250001.000200");
  assert.equal(pokes, 1);

  // Persistence failure must fail the delivery so Slack retries it.
  failEnqueue = true;
  const failed = await send("1788250002.000300");
  assert.equal(failed.status, 500);
});
