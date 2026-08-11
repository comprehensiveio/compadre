import assert from "node:assert/strict";
import test from "node:test";
import { recoverStaleSlackRuns } from "./slack-run-recovery.js";

interface SlackCall {
  method: string;
  body?: Record<string, unknown>;
  cursor?: string;
}

const silentLogger = {
  info() {},
  warn() {},
};

function createSlackFetch(
  responses: Record<string, Array<Record<string, unknown>>>,
) {
  const calls: SlackCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = url.pathname.split("/").pop() || "";
    calls.push({
      method,
      ...(init?.body
        ? { body: JSON.parse(String(init.body)) as Record<string, unknown> }
        : {}),
      ...(url.searchParams.get("cursor")
        ? { cursor: url.searchParams.get("cursor")! }
        : {}),
    });
    const response = responses[method]?.shift() ?? { ok: true };
    return Response.json(response);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("marks paginated, deduplicated thinking reactions as failed", async () => {
  const thinkingMessage = {
    type: "message",
    channel: "C123",
    message: {
      ts: "200.002",
      thread_ts: "100.001",
      reactions: [
        { name: "compadre-thinking", users: ["UCOMPADRE"] },
      ],
    },
  };
  const { calls, fetchImpl } = createSlackFetch({
    "auth.test": [{ ok: true, user_id: "UCOMPADRE" }],
    "reactions.list": [
      {
        ok: true,
        items: [thinkingMessage],
        response_metadata: { next_cursor: "next" },
      },
      { ok: true, items: [thinkingMessage] },
    ],
    "reactions.remove": [{ ok: true }],
    "reactions.add": [{ ok: true }],
    "assistant.threads.setStatus": [{ ok: true }],
  });

  const result = await recoverStaleSlackRuns({
    botToken: "xoxb-test",
    fetchImpl,
    logger: silentLogger,
  });

  assert.deepEqual(result, { recovered: 1, scanned: 2 });
  assert.deepEqual(
    calls.map(({ method }) => method),
    [
      "auth.test",
      "reactions.list",
      "reactions.list",
      "reactions.remove",
      "reactions.add",
      "assistant.threads.setStatus",
    ],
  );
  assert.equal(calls[2]?.cursor, "next");
  assert.deepEqual(calls[3]?.body, {
    channel: "C123",
    timestamp: "200.002",
    name: "compadre-thinking",
  });
  assert.deepEqual(calls[4]?.body, {
    channel: "C123",
    timestamp: "200.002",
    name: "compadre-failure",
  });
  assert.deepEqual(calls[5]?.body, {
    channel_id: "C123",
    thread_ts: "100.001",
    status: "",
  });
});

test("does not create a false failure when the thinking reaction is already gone", async () => {
  const { calls, fetchImpl } = createSlackFetch({
    "auth.test": [{ ok: true, user_id: "UCOMPADRE" }],
    "reactions.list": [
      {
        ok: true,
        items: [
          {
            type: "message",
            channel: "C123",
            message: {
              ts: "100.001",
              reactions: [
                { name: "compadre-thinking", users: ["UCOMPADRE"] },
              ],
            },
          },
        ],
      },
    ],
    "reactions.remove": [{ ok: false, error: "no_reaction" }],
  });

  const result = await recoverStaleSlackRuns({
    botToken: "xoxb-test",
    fetchImpl,
    logger: silentLogger,
  });

  assert.deepEqual(result, { recovered: 0, scanned: 1 });
  assert.deepEqual(
    calls.map(({ method }) => method),
    ["auth.test", "reactions.list", "reactions.remove"],
  );
});
