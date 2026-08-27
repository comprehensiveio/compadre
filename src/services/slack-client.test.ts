import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SLACK_MARKDOWN_TEXT_LIMIT,
  SLACK_TRUNCATION_NOTICE,
} from "./slack-markdown.js";
import { SlackClient } from "./slack-client.js";

interface SlackCall {
  url: string;
  init?: RequestInit;
}

function createSlackFetch(
  responses: Array<{ body?: Record<string, unknown>; status?: number }>,
) {
  const calls: SlackCall[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(input), init });
    const response = responses.shift() ?? { body: { ok: true } };
    return new Response(JSON.stringify(response.body ?? { ok: true }), {
      status: response.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function jsonBody(call: SlackCall): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

test("posts and replies using bounded standard Markdown", async () => {
  const { calls, fetchImpl } = createSlackFetch([
    { body: { ok: true, ts: "100.001" } },
    { body: { ok: true, ts: "100.002" } },
  ]);
  const client = new SlackClient({
    botToken: "xoxb-test",
    teamId: "T123",
    fetchImpl,
  });
  const markdown = [
    "## Status",
    "",
    "| Service | State |",
    "| --- | --- |",
    "| API | **Healthy** |",
  ].join("\n");

  await client.postMessage("C123", markdown);
  await client.replyToThread(
    "C123",
    "99.001",
    "x".repeat(SLACK_MARKDOWN_TEXT_LIMIT + 1),
    "c352d625-4219-4b00-9b22-f1416c136a65",
  );

  assert.deepEqual(jsonBody(calls[0]!), {
    channel: "C123",
    markdown_text: markdown,
  });
  assert.equal("text" in jsonBody(calls[0]!), false);
  assert.deepEqual(jsonBody(calls[1]!), {
    channel: "C123",
    thread_ts: "99.001",
    markdown_text:
      "x".repeat(SLACK_MARKDOWN_TEXT_LIMIT - SLACK_TRUNCATION_NOTICE.length) +
      SLACK_TRUNCATION_NOTICE,
    client_msg_id: "c352d625-4219-4b00-9b22-f1416c136a65",
  });
});

test("preserves the existing Slack read API contract", async () => {
  const { calls, fetchImpl } = createSlackFetch([
    { body: { ok: true, messages: [] } },
  ]);
  const client = new SlackClient({
    botToken: "xoxb-test",
    teamId: "T123",
    fetchImpl,
  });

  await client.getChannelHistory("C123", 25);

  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/conversations.history");
  assert.equal(url.searchParams.get("channel"), "C123");
  assert.equal(url.searchParams.get("limit"), "25");
});

test("reads a Slack user through the bot-compatible users.info API", async () => {
  const { calls, fetchImpl } = createSlackFetch([
    { body: { ok: true, user: { id: "U123" } } },
  ]);
  const client = new SlackClient({
    botToken: "xoxb-test",
    teamId: "T123",
    fetchImpl,
  });

  await client.getUserInfo("U123");

  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/users.info");
  assert.equal(url.searchParams.get("user"), "U123");
});

test("downloads a private Slack image with bot authentication", async () => {
  const calls: SlackCall[] = [];
  const image = new Uint8Array([137, 80, 78, 71]);
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(input), init });
    if (calls.length === 1) {
      return Response.json({
        ok: true,
        file: {
          name: "screenshot.png",
          mimetype: "image/png",
          size: image.byteLength,
          url_private_download:
            "https://files.slack.com/files-pri/T123-F123/download/screenshot.png",
        },
      });
    }
    return new Response(image, {
      headers: { "Content-Type": "image/png" },
    });
  }) as typeof fetch;
  const client = new SlackClient({
    botToken: "xoxb-test",
    teamId: "T123",
    fetchImpl,
  });

  const downloaded = await client.downloadFile("F123");

  assert.deepEqual(downloaded, {
    data: image,
    name: "screenshot.png",
    mimetype: "image/png",
  });
  const infoUrl = new URL(calls[0]!.url);
  assert.equal(infoUrl.pathname, "/api/files.info");
  assert.equal(infoUrl.searchParams.get("file"), "F123");
  assert.equal(calls[1]!.url, "https://files.slack.com/files-pri/T123-F123/download/screenshot.png");
  assert.equal(
    new Headers(calls[1]!.init?.headers).get("authorization"),
    "Bearer xoxb-test",
  );
});

test("rejects oversized Slack images before downloading them", async () => {
  const { calls, fetchImpl } = createSlackFetch([
    {
      body: {
        ok: true,
        file: {
          name: "huge.png",
          mimetype: "image/png",
          size: 101,
          url_private_download:
            "https://files.slack.com/files-pri/T123-F123/download/huge.png",
        },
      },
    },
  ]);
  const client = new SlackClient({
    botToken: "xoxb-test",
    teamId: "T123",
    fetchImpl,
  });

  await assert.rejects(client.downloadFile("F123", 100), /exceeds/);
  assert.equal(calls.length, 1);
});

test("uploads a local file directly to the requested Slack thread", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "compadre-slack-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "report.csv");
  await fs.writeFile(filePath, "service,status\napi,healthy\n");

  const { calls, fetchImpl } = createSlackFetch([
    {
      body: {
        ok: true,
        upload_url: "https://uploads.slack.test/file",
        file_id: "F123",
      },
    },
    { body: { ok: true } },
    { body: { ok: true, files: [{ id: "F123" }] } },
  ]);
  const client = new SlackClient({
    botToken: "xoxb-test",
    teamId: "T123",
    fetchImpl,
  });

  await client.uploadFile({
    channel: "C123",
    threadTs: "99.001",
    filePath,
    title: "On-call report",
  });

  assert.equal(
    new URL(calls[0]!.url).pathname,
    "/api/files.getUploadURLExternal",
  );
  const uploadRequest = new URLSearchParams(String(calls[0]!.init?.body));
  assert.equal(uploadRequest.get("filename"), "report.csv");
  assert.equal(uploadRequest.get("length"), "27");
  assert.equal(calls[1]!.url, "https://uploads.slack.test/file");
  assert.equal(String(calls[1]!.init?.body), "service,status\napi,healthy\n");
  assert.deepEqual(jsonBody(calls[2]!), {
    files: [{ id: "F123", title: "On-call report" }],
    channel_id: "C123",
    thread_ts: "99.001",
  });
});

test("surfaces Slack API errors to the agent", async () => {
  const { fetchImpl } = createSlackFetch([
    { body: { ok: false, error: "not_in_channel" } },
  ]);
  const client = new SlackClient({
    botToken: "xoxb-test",
    teamId: "T123",
    fetchImpl,
  });

  await assert.rejects(
    client.postMessage("C123", "hello"),
    /chat\.postMessage failed: not_in_channel/,
  );
});
