import assert from "node:assert/strict";
import test from "node:test";
import { SlackStream } from "./slack-stream.js";

interface SlackCall {
  method: string;
  body: Record<string, unknown>;
}

const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

function createSlackFetch(
  responses: Record<string, Array<Record<string, unknown>>>,
) {
  const calls: SlackCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = new URL(String(input)).pathname.split("/").pop() || "";
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ method, body });

    const response = responses[method]?.shift() ?? { ok: true };
    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return { calls, fetchImpl };
}

test("uses Slack-native streaming for channel threads", async () => {
  const { calls, fetchImpl } = createSlackFetch({
    "chat.startStream": [{ ok: true, ts: "200.001" }],
    "chat.appendStream": [{ ok: true }],
    "chat.stopStream": [{ ok: true }],
  });
  const stream = new SlackStream({
    channel: "C123",
    threadTs: "100.001",
    botToken: "xoxb-test",
    recipientUserId: "U123",
    recipientTeamId: "T123",
    fetchImpl,
    flushIntervalMs: 0,
    logger: silentLogger,
  });

  stream.appendText("Hello ");
  await new Promise((resolve) => setTimeout(resolve, 5));
  stream.appendText("world");
  await stream.stopStream();

  assert.deepEqual(calls, [
    {
      method: "chat.startStream",
      body: {
        channel: "C123",
        thread_ts: "100.001",
        markdown_text: "Hello ",
        recipient_user_id: "U123",
        recipient_team_id: "T123",
      },
    },
    {
      method: "chat.appendStream",
      body: {
        channel: "C123",
        ts: "200.001",
        markdown_text: "world",
      },
    },
    {
      method: "chat.stopStream",
      body: {
        channel: "C123",
        ts: "200.001",
      },
    },
  ]);
});

test("publishes channel loading states without requiring assistant view", async () => {
  const { calls, fetchImpl } = createSlackFetch({
    "assistant.threads.setStatus": [{ ok: true }, { ok: true }],
  });
  const stream = new SlackStream({
    channel: "C123",
    threadTs: "100.001",
    botToken: "xoxb-test",
    fetchImpl,
    logger: silentLogger,
  });

  await stream.setStatus("is thinking...");
  await stream.clearStatus();

  assert.deepEqual(calls, [
    {
      method: "assistant.threads.setStatus",
      body: {
        channel_id: "C123",
        thread_ts: "100.001",
        status: "is thinking...",
      },
    },
    {
      method: "assistant.threads.setStatus",
      body: {
        channel_id: "C123",
        thread_ts: "100.001",
        status: "",
      },
    },
  ]);
});

test("falls back to a normal thread message when native streaming is unavailable", async () => {
  const { calls, fetchImpl } = createSlackFetch({
    "chat.startStream": [{ ok: false, error: "channel_type_not_supported" }],
    "chat.postMessage": [{ ok: true, ts: "200.001" }],
  });
  const stream = new SlackStream({
    channel: "C123",
    threadTs: "100.001",
    botToken: "xoxb-test",
    recipientUserId: "U123",
    recipientTeamId: "T123",
    fetchImpl,
    logger: silentLogger,
  });

  stream.appendText("Fallback response");
  await stream.stopStream();

  assert.deepEqual(calls, [
    {
      method: "chat.startStream",
      body: {
        channel: "C123",
        thread_ts: "100.001",
        markdown_text: "Fallback response",
        recipient_user_id: "U123",
        recipient_team_id: "T123",
      },
    },
    {
      method: "chat.postMessage",
      body: {
        channel: "C123",
        thread_ts: "100.001",
        text: "Fallback response",
      },
    },
  ]);
});

test("finishes with message updates if Slack closes a native stream", async () => {
  const { calls, fetchImpl } = createSlackFetch({
    "chat.startStream": [{ ok: true, ts: "200.001" }],
    "chat.appendStream": [{ ok: false, error: "stream_closed" }],
    "chat.update": [{ ok: true }, { ok: true }],
  });
  const stream = new SlackStream({
    channel: "C123",
    threadTs: "100.001",
    botToken: "xoxb-test",
    recipientUserId: "U123",
    recipientTeamId: "T123",
    fetchImpl,
    flushIntervalMs: 0,
    logger: silentLogger,
  });

  stream.appendText("One ");
  await new Promise((resolve) => setTimeout(resolve, 5));
  stream.appendText("two ");
  await new Promise((resolve) => setTimeout(resolve, 5));
  stream.appendText("three");
  await stream.stopStream();

  assert.deepEqual(
    calls.map(({ method }) => method),
    [
      "chat.startStream",
      "chat.appendStream",
      "chat.update",
      "chat.update",
    ],
  );
  assert.equal(calls.at(-1)?.body.text, "One two three");
});

test("salvages the final response if stopping a native stream fails", async () => {
  const { calls, fetchImpl } = createSlackFetch({
    "chat.startStream": [{ ok: true, ts: "200.001" }],
    "chat.stopStream": [{ ok: false, error: "stream_closed" }],
    "chat.update": [{ ok: true }],
  });
  const stream = new SlackStream({
    channel: "C123",
    threadTs: "100.001",
    botToken: "xoxb-test",
    recipientUserId: "U123",
    recipientTeamId: "T123",
    fetchImpl,
    logger: silentLogger,
  });

  stream.appendText("Complete response");
  await stream.stopStream();

  assert.deepEqual(
    calls.map(({ method }) => method),
    ["chat.startStream", "chat.stopStream", "chat.update"],
  );
  assert.equal(calls.at(-1)?.body.text, "Complete response");
});

test("recovers missing text when both append and its immediate update fail", async () => {
  const { calls, fetchImpl } = createSlackFetch({
    "chat.startStream": [{ ok: true, ts: "200.001" }],
    "chat.appendStream": [{ ok: false, error: "stream_closed" }],
    "chat.update": [
      { ok: false, error: "message_not_found" },
      { ok: true },
    ],
    "chat.stopStream": [{ ok: true }],
  });
  const stream = new SlackStream({
    channel: "C123",
    threadTs: "100.001",
    botToken: "xoxb-test",
    recipientUserId: "U123",
    recipientTeamId: "T123",
    fetchImpl,
    flushIntervalMs: 0,
    logger: silentLogger,
  });

  stream.appendText("One ");
  await new Promise((resolve) => setTimeout(resolve, 5));
  stream.appendText("two");
  await stream.stopStream();

  assert.deepEqual(
    calls.map(({ method }) => method),
    [
      "chat.startStream",
      "chat.appendStream",
      "chat.update",
      "chat.stopStream",
      "chat.update",
    ],
  );
  assert.equal(calls.at(-1)?.body.text, "One two");
});
