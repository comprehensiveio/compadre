import assert from "node:assert/strict";
import test from "node:test";
import {
  SLACK_MARKDOWN_TEXT_LIMIT,
  SLACK_TRUNCATION_NOTICE,
} from "./slack-markdown.js";
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

function assertBoundedMarkdownCalls(calls: SlackCall[]): void {
  for (const call of calls) {
    if (typeof call.body.markdown_text === "string") {
      assert.ok(
        call.body.markdown_text.length <= SLACK_MARKDOWN_TEXT_LIMIT,
        `${call.method} exceeded Slack's Markdown limit`,
      );
    }
  }
}

test("streams standard Markdown unchanged in channel threads", async () => {
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

  const firstChunk = [
    "## Results",
    "",
    "| Service | Status |",
    "| --- | --- |",
    "| API | ",
  ].join("\n");
  const secondChunk = [
    "**Healthy** |",
    "",
    "- [x] Checked",
    "",
    "```ts",
    "const ok = true;",
    "```",
  ].join("\n");

  stream.appendText(firstChunk);
  await new Promise((resolve) => setTimeout(resolve, 5));
  stream.appendText(secondChunk);
  await stream.stopStream();

  assert.deepEqual(calls, [
    {
      method: "chat.startStream",
      body: {
        channel: "C123",
        thread_ts: "100.001",
        markdown_text: firstChunk,
        recipient_user_id: "U123",
        recipient_team_id: "T123",
      },
    },
    {
      method: "chat.appendStream",
      body: {
        channel: "C123",
        ts: "200.001",
        markdown_text: secondChunk,
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
        markdown_text: "Fallback response",
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
  assert.equal(calls.at(-1)?.body.markdown_text, "One two three");
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
  assert.equal(calls.at(-1)?.body.markdown_text, "Complete response");
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
  assert.equal(calls.at(-1)?.body.markdown_text, "One two");
});

test("bounds an oversized initial stream chunk", async () => {
  const { calls, fetchImpl } = createSlackFetch({
    "chat.startStream": [{ ok: true, ts: "200.001" }],
    "chat.stopStream": [{ ok: true }],
  });
  const stream = new SlackStream({
    channel: "C123",
    threadTs: "100.001",
    botToken: "xoxb-test",
    fetchImpl,
    logger: silentLogger,
  });

  stream.appendText("x".repeat(SLACK_MARKDOWN_TEXT_LIMIT + 1));
  await stream.stopStream();

  assertBoundedMarkdownCalls(calls);
  assert.ok(
    String(calls[0]?.body.markdown_text).endsWith(SLACK_TRUNCATION_NOTICE),
  );
});

test("bounds accumulated Markdown during interrupted-stream recovery", async () => {
  const { calls, fetchImpl } = createSlackFetch({
    "chat.startStream": [{ ok: true, ts: "200.001" }],
    "chat.appendStream": [{ ok: false, error: "stream_closed" }],
    "chat.update": [{ ok: true }],
  });
  const stream = new SlackStream({
    channel: "C123",
    threadTs: "100.001",
    botToken: "xoxb-test",
    fetchImpl,
    flushIntervalMs: 0,
    logger: silentLogger,
  });

  stream.appendText("x".repeat(8_000));
  await new Promise((resolve) => setTimeout(resolve, 5));
  stream.appendText("y".repeat(8_000));
  await stream.stopStream();

  assertBoundedMarkdownCalls(calls);
  const recovery = calls.find(({ method }) => method === "chat.update");
  assert.ok(
    String(recovery?.body.markdown_text).endsWith(SLACK_TRUNCATION_NOTICE),
  );
});

test("bounds Markdown during failed-stop recovery", async () => {
  const { calls, fetchImpl } = createSlackFetch({
    "chat.startStream": [{ ok: true, ts: "200.001" }],
    "chat.stopStream": [{ ok: false, error: "stream_closed" }],
    "chat.update": [{ ok: true }],
  });
  const stream = new SlackStream({
    channel: "C123",
    threadTs: "100.001",
    botToken: "xoxb-test",
    fetchImpl,
    logger: silentLogger,
  });

  stream.appendText("x".repeat(SLACK_MARKDOWN_TEXT_LIMIT + 1));
  await stream.stopStream();

  assertBoundedMarkdownCalls(calls);
  const recovery = calls.find(({ method }) => method === "chat.update");
  assert.ok(
    String(recovery?.body.markdown_text).endsWith(SLACK_TRUNCATION_NOTICE),
  );
});
