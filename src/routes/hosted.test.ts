import assert from "node:assert/strict";
import test from "node:test";
import { EventType } from "@tanstack/ai";
import { memoryPersistence } from "@tanstack/ai-persistence";
import { Hono } from "hono";
import { createAgentRunDurability } from "../durability/runtime.js";
import type { HostedSlackBinding } from "../services/hosted-thread-bindings.js";
import { createHostedRoutes } from "./hosted.js";

const slackBinding: HostedSlackBinding = {
  channelId: "C123",
  threadTs: "1712345678.000100",
  recipientUserId: "U123",
  recipientTeamId: "T123",
};

function authorizedJson(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: {
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

test("a web turn starts one durable run and fans a Slack-bound thread back to Slack", async (t) => {
  const previousApiKey = process.env.COMPADRE_API_KEY;
  process.env.COMPADRE_API_KEY = "test-key";
  t.after(() => {
    if (previousApiKey === undefined) delete process.env.COMPADRE_API_KEY;
    else process.env.COMPADRE_API_KEY = previousApiKey;
  });

  const durability = await createAgentRunDurability({
    COMPADRE_DURABILITY_BACKEND: "memory",
  });
  assert.ok(durability);
  const persistence = memoryPersistence();
  const deliveries: Array<{
    binding: HostedSlackBinding;
    message: string;
    runId: string;
  }> = [];
  const app = new Hono();
  app.route(
    "/",
    createHostedRoutes({
      enabled: () => true,
      getDurability: async () => durability,
      getThreadPersistence: async () => ({
        persistence,
        locks: {} as never,
        sandboxInstances: {} as never,
      }),
      resolveThreadId: async (threadId) =>
        threadId === "t3-thread" ? "slack-thread" : threadId,
      bindThreadAlias: async () => {},
      getSlackBinding: async (threadId) =>
        threadId === "slack-thread" ? slackBinding : null,
      bindSlack: async () => {},
      createId: () => "generated-id",
      getLauncher: () => ({
        async start(input) {
          assert.equal(input.runId, "web-run");
          assert.equal(input.threadId, "slack-thread");
          assert.match(input.prompt, /User query:\nhello from the browser/);
          assert.match(input.prompt, /Reply to:/);
          assert.match(input.prompt, /- channel: C123/);
          assert.match(input.prompt, /- thread_ts: 1712345678\.000100/);
          assert.equal(input.transcriptUserMessage, "hello from the browser");
          assert.equal(input.persistThread, true);
          assert.equal(input.responseMode, "slack-streaming");
          assert.deepEqual(input.inputFiles, [
            {
              name: "probe.png",
              mimetype: "image/png",
              sizeBytes: 4,
              dataBase64: "iVBORw==",
            },
          ]);
          await persistence.stores.messages.saveThread("slack-thread", [
            { role: "user", content: "hello from the browser" },
            { role: "assistant", content: "hello from Compadre" },
          ]);
          await durability.stream("web-run").append([
            {
              type: EventType.RUN_STARTED,
              runId: "web-run",
              threadId: "slack-thread",
              timestamp: 1,
            },
            {
              type: EventType.TEXT_MESSAGE_START,
              messageId: "assistant-message",
              role: "assistant",
              timestamp: 2,
            },
            {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: "assistant-message",
              delta: "hello from Compadre",
              timestamp: 3,
            },
            {
              type: EventType.TEXT_MESSAGE_END,
              messageId: "assistant-message",
              timestamp: 4,
            },
            {
              type: EventType.RUN_FINISHED,
              runId: "web-run",
              threadId: "slack-thread",
              timestamp: 5,
            },
          ]);
          await durability.runs.update("web-run", {
            status: "completed",
            finishedAt: 5,
          });
          await durability.stream("web-run").close();
          return { taskRunId: "task-1" };
        },
      }),
      startSlackDelivery(input) {
        deliveries.push({
          binding: input.binding,
          message: input.userMessage,
          runId: input.runId,
        });
      },
    }),
  );

  const response = await app.request(
    "/hosted/chat",
    authorizedJson({
      threadId: "t3-thread",
      runId: "web-run",
      messages: [
        {
          id: "user-message",
          role: "user",
          content: "hello from the browser",
        },
      ],
      tools: [],
      context: [],
      forwardedProps: {
        provider: "codex",
        inputFiles: [
          {
            name: "probe.png",
            mimetype: "image/png",
            sizeBytes: 4,
            dataBase64: "iVBORw==",
          },
        ],
      },
      state: {},
    }),
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const stream = await response.text();
  assert.match(stream, /"type":"TEXT_MESSAGE_CONTENT"/);
  assert.match(stream, /"delta":"hello from Compadre"/);
  assert.deepEqual(deliveries, [
    {
      binding: slackBinding,
      message: "hello from the browser",
      runId: "web-run",
    },
  ]);

  const hydration = await app.request(
    "/hosted/chat?threadId=t3-thread",
    { headers: { Authorization: "Bearer test-key" } },
  );
  assert.equal(hydration.status, 200);
  const hydrated = (await hydration.json()) as {
    messages: Array<{ role: string; parts: Array<{ content?: string }> }>;
  };
  assert.equal(hydrated.messages[0]?.role, "user");
  assert.equal(hydrated.messages[0]?.parts[0]?.content, "hello from the browser");
  assert.equal(hydrated.messages[1]?.role, "assistant");
  assert.equal(hydrated.messages[1]?.parts[0]?.content, "hello from Compadre");

  const resumed = await app.request(
    "/hosted/chat?threadId=slack-thread&runId=web-run&offset=-1",
    { headers: { Authorization: "Bearer test-key" } },
  );
  assert.equal(resumed.status, 200);
  assert.equal(resumed.headers.get("content-type"), "text/event-stream");
  assert.match(await resumed.text(), /"delta":"hello from Compadre"/);
});

test("a browser can explicitly link an existing Compadre thread to Slack", async (t) => {
  const previousApiKey = process.env.COMPADRE_API_KEY;
  process.env.COMPADRE_API_KEY = "test-key";
  t.after(() => {
    if (previousApiKey === undefined) delete process.env.COMPADRE_API_KEY;
    else process.env.COMPADRE_API_KEY = previousApiKey;
  });

  const bindings: Array<{ threadId: string; binding: HostedSlackBinding }> = [];
  const aliases: Array<{ aliasThreadId: string; canonicalThreadId: string }> = [];
  const app = new Hono();
  app.route(
    "/",
    createHostedRoutes({
      enabled: () => true,
      getDurability: async () => null,
      getThreadPersistence: async () => null,
      resolveThreadId: async (threadId) => threadId,
      bindThreadAlias: async (aliasThreadId, canonicalThreadId) => {
        aliases.push({ aliasThreadId, canonicalThreadId });
      },
      getSlackBinding: async () => null,
      bindSlack: async (threadId, binding) => {
        bindings.push({ threadId, binding });
      },
      createId: () => "unused",
      getLauncher: () => ({
        async start() {
          throw new Error("should not start");
        },
      }),
      startSlackDelivery() {
        throw new Error("should not deliver");
      },
    }),
  );

  const response = await app.request(
    "/hosted/threads/slack-thread/slack",
    authorizedJson({ channelId: "C123", threadTs: "1712345678.000100" }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(aliases, [
    {
      aliasThreadId: "slack-thread",
      canonicalThreadId: "1712345678.000100",
    },
  ]);
  assert.deepEqual(bindings, [
    {
      threadId: "1712345678.000100",
      binding: {
        channelId: "C123",
        threadTs: "1712345678.000100",
      },
    },
  ]);
});

test("a browser can cancel its active durable run", async (t) => {
  const previousApiKey = process.env.COMPADRE_API_KEY;
  process.env.COMPADRE_API_KEY = "test-key";
  t.after(() => {
    if (previousApiKey === undefined) delete process.env.COMPADRE_API_KEY;
    else process.env.COMPADRE_API_KEY = previousApiKey;
  });
  const durability = await createAgentRunDurability({
    COMPADRE_DURABILITY_BACKEND: "memory",
  });
  assert.ok(durability);
  await durability.runs.createOrResume({
    runId: "active-web-run",
    threadId: "web-thread",
    startedAt: 1,
  });
  const cancelled: string[] = [];
  const app = new Hono();
  app.route(
    "/",
    createHostedRoutes({
      enabled: () => true,
      getDurability: async () => durability,
      getThreadPersistence: async () => null,
      resolveThreadId: async (threadId) => threadId,
      bindThreadAlias: async () => {},
      getSlackBinding: async () => null,
      bindSlack: async () => {},
      createId: () => "unused",
      getLauncher: () => ({
        async start() {
          throw new Error("should not start");
        },
        async cancelRun(runId) {
          cancelled.push(runId);
          return true;
        },
      }),
      startSlackDelivery() {},
    }),
  );

  const response = await app.request("/hosted/runs/active-web-run/cancel", {
    method: "POST",
    headers: { Authorization: "Bearer test-key" },
  });
  assert.equal(response.status, 202);
  assert.deepEqual(cancelled, ["active-web-run"]);
  assert.deepEqual(await response.json(), {
    ok: true,
    cancelled: true,
    status: "cancelling",
  });
});

test("pairing refuses to orphan an existing T3-side transcript", async (t) => {
  const previousApiKey = process.env.COMPADRE_API_KEY;
  process.env.COMPADRE_API_KEY = "test-key";
  t.after(() => {
    if (previousApiKey === undefined) delete process.env.COMPADRE_API_KEY;
    else process.env.COMPADRE_API_KEY = previousApiKey;
  });

  const persistence = memoryPersistence();
  await persistence.stores.messages.saveThread("t3-with-history", [
    { role: "user", content: "an existing turn" },
  ]);
  const app = new Hono();
  app.route(
    "/",
    createHostedRoutes({
      enabled: () => true,
      getDurability: async () => null,
      getThreadPersistence: async () => ({
        persistence,
        locks: {} as never,
        sandboxInstances: {} as never,
      }),
      resolveThreadId: async (threadId) => threadId,
      bindThreadAlias: async () => {
        throw new Error("should not bind");
      },
      getSlackBinding: async () => null,
      bindSlack: async () => {
        throw new Error("should not bind Slack");
      },
      createId: () => "unused",
      getLauncher: () => ({
        async start() {
          throw new Error("should not start");
        },
      }),
      startSlackDelivery() {
        throw new Error("should not deliver");
      },
    }),
  );

  const response = await app.request(
    "/hosted/threads/t3-with-history/slack",
    authorizedJson({ channelId: "C123", threadTs: "1712345678.000100" }),
  );

  assert.equal(response.status, 409);
  assert.match(await response.text(), /automatic history merging/);
});

test("a browser turn waits through a cold harness start in memory mode", async (t) => {
  const previousApiKey = process.env.COMPADRE_API_KEY;
  process.env.COMPADRE_API_KEY = "test-key";
  t.after(() => {
    if (previousApiKey === undefined) delete process.env.COMPADRE_API_KEY;
    else process.env.COMPADRE_API_KEY = previousApiKey;
  });

  const durability = await createAgentRunDurability({
    COMPADRE_DURABILITY_BACKEND: "memory",
  });
  assert.ok(durability);
  const app = new Hono();
  app.route(
    "/",
    createHostedRoutes({
      enabled: () => true,
      getDurability: async () => durability,
      getThreadPersistence: async () => null,
      resolveThreadId: async (threadId) => threadId,
      bindThreadAlias: async () => {},
      getSlackBinding: async () => null,
      bindSlack: async () => {},
      createId: () => "slow-web-run",
      getLauncher: () => ({
        async start() {
          setTimeout(() => {
            void (async () => {
              await durability.stream("slow-web-run").append([
                {
                  type: EventType.RUN_STARTED,
                  runId: "slow-web-run",
                  threadId: "slow-web-thread",
                  timestamp: 1,
                },
                {
                  type: EventType.TEXT_MESSAGE_START,
                  messageId: "assistant-message",
                  role: "assistant",
                  timestamp: 2,
                },
                {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "assistant-message",
                  delta: "started after the local fail-fast",
                  timestamp: 3,
                },
                {
                  type: EventType.TEXT_MESSAGE_END,
                  messageId: "assistant-message",
                  timestamp: 4,
                },
                {
                  type: EventType.RUN_FINISHED,
                  runId: "slow-web-run",
                  threadId: "slow-web-thread",
                  timestamp: 5,
                },
              ]);
              await durability.stream("slow-web-run").close();
            })();
          }, 250);
          return { taskRunId: "slow-task" };
        },
      }),
      startSlackDelivery() {},
    }),
  );

  const response = await app.request(
    "/hosted/chat",
    authorizedJson({
      threadId: "slow-web-thread",
      runId: "slow-web-run",
      messages: [
        { id: "slow-user-message", role: "user", content: "start slowly" },
      ],
      tools: [],
      context: [],
      forwardedProps: {},
      state: {},
    }),
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /started after the local fail-fast/);
});

test("the hosted interface stays dark and fails closed when disabled", async () => {
  const app = new Hono();
  app.route(
    "/",
    createHostedRoutes({
      enabled: () => false,
      getDurability: async () => null,
      getThreadPersistence: async () => null,
      resolveThreadId: async (threadId) => threadId,
      bindThreadAlias: async () => {},
      getSlackBinding: async () => null,
      bindSlack: async () => {},
      createId: () => "unused",
      getLauncher: () => ({
        async start() {
          throw new Error("should not start");
        },
      }),
      startSlackDelivery() {
        throw new Error("should not deliver");
      },
    }),
  );

  const response = await app.request("/hosted/chat", { method: "POST" });
  assert.equal(response.status, 404);
});
