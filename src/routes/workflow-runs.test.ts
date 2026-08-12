import assert from "node:assert/strict";
import test from "node:test";
import { EventType } from "@tanstack/ai";
import { Hono } from "hono";
import { createAgentRunDurability } from "../durability/runtime.js";
import { createWorkflowRunRoutes } from "./workflow-runs.js";

test("starts a local durable run and serves resumable AG-UI events", async (t) => {
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
    createWorkflowRunRoutes({
      enabled: () => true,
      getDurability: async () => durability,
      createId: () => "route-run",
      getLauncher: () => ({
        async start(input) {
          assert.equal(input.runId, "route-run");
          await durability.runs.createOrResume({
            runId: "route-run",
            threadId: "workflow-route-run",
            startedAt: 1,
          });
          await durability.stream("route-run").append([
            {
              type: EventType.RUN_STARTED,
              runId: "route-run",
              threadId: "workflow-route-run",
              timestamp: 1,
            },
            {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: "message",
              delta: "hello",
              timestamp: 2,
            },
            {
              type: EventType.RUN_FINISHED,
              runId: "route-run",
              threadId: "workflow-route-run",
              timestamp: 3,
            },
          ]);
          await durability.runs.update("route-run", {
            status: "completed",
            finishedAt: 3,
          });
          await durability.stream("route-run").close();
          return { taskRunId: "local-task" };
        },
      }),
    }),
  );

  const started = await app.request("/workflow-runs", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "hello" }),
  });
  assert.equal(started.status, 202);
  const body = (await started.json()) as {
    runId: string;
    eventsUrl: string;
  };
  assert.equal(body.runId, "route-run");

  const stream = await app.request(body.eventsUrl, {
    headers: { Authorization: "Bearer test-key" },
  });
  assert.equal(stream.status, 200);
  assert.equal(stream.headers.get("content-type"), "text/event-stream");
  assert.equal(stream.headers.get("x-accel-buffering"), "no");
  const text = await stream.text();
  assert.match(text, /id: memory:v1:route-run:1/);
  assert.match(text, /"type":"TEXT_MESSAGE_CONTENT"/);
  assert.match(text, /"delta":"hello"/);

  const firstOffset = "memory:v1:route-run:1";
  const resumed = await app.request(
    `/workflow-runs/route-run/events?offset=${encodeURIComponent(firstOffset)}`,
    { headers: { Authorization: "Bearer test-key" } },
  );
  assert.equal(resumed.status, 200);
  const resumedText = await resumed.text();
  assert.doesNotMatch(resumedText, /"type":"RUN_STARTED"/);
  assert.match(resumedText, /"delta":"hello"/);
});

test("terminalizes fire-and-tail runs when the Workflow task fails", async (t) => {
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
    createWorkflowRunRoutes({
      enabled: () => true,
      getDurability: async () => durability,
      createId: () => "failed-route-run",
      getLauncher: () => ({
        async start() {
          return { taskRunId: "failed-task" };
        },
        async wait() {
          throw new Error("Render task was killed");
        },
      }),
    }),
  );

  const started = await app.request("/workflow-runs", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "hello" }),
  });
  assert.equal(started.status, 202);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(
    (await durability.runs.get("failed-route-run"))?.status,
    "failed",
  );
  const snapshot = await durability.stream("failed-route-run").snapshot();
  assert.equal(snapshot.at(-1)?.chunk.type, EventType.RUN_ERROR);
});

test("preserves route launcher failure when durability finalization also fails", async (t) => {
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
  durability.runs.get = async () => {
    throw new Error("finalization failed");
  };
  t.mock.method(console, "error", () => undefined);
  const app = new Hono();
  app.onError((error, c) => c.text(error.message, 500));
  app.route(
    "/",
    createWorkflowRunRoutes({
      enabled: () => true,
      getDurability: async () => durability,
      createId: () => "route-startup-failure",
      getLauncher: () => ({
        async start() {
          throw new Error("launcher startup failed");
        },
      }),
    }),
  );

  const response = await app.request("/workflow-runs", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "hello" }),
  });

  assert.equal(response.status, 500);
  assert.equal(await response.text(), "launcher startup failed");
});
