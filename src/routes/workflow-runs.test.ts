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
  const resumedText = await resumed.text();
  assert.doesNotMatch(resumedText, /"type":"RUN_STARTED"/);
  assert.match(resumedText, /"delta":"hello"/);
});
