import assert from "node:assert/strict";
import test from "node:test";
import { EventType } from "@tanstack/ai";
import { createAgentRunDurability } from "../durability/runtime.js";
import { runWorkflowConversation } from "./workflow-conversation.js";

test("relays a Workflow AG-UI log through channel callbacks", async () => {
  const durability = await createAgentRunDurability({
    COMPADRE_DURABILITY_BACKEND: "memory",
  });
  assert.ok(durability);
  const text: string[] = [];
  const statuses: string[] = [];
  let completed = 0;

  const result = await runWorkflowConversation(
    {
      prompt: "hello",
      threadId: "slack-thread",
      provider: "claude-code",
      slackFiles: [{ id: "F123", name: "screenshot.png" }],
      stream: {
        onTextDelta: (delta) => text.push(delta),
        onToolStart: (name) => statuses.push(name),
        onComplete: () => {
          completed += 1;
        },
      },
    },
    {
      getDurability: async () => durability,
      createId: () => "relayed-run",
      now: () => 1,
      getLauncher: () => ({
        async start(input) {
          assert.equal(input.responseMode, "slack-streaming");
          assert.equal(input.persistThread, true);
          assert.deepEqual(input.slackFiles, [
            { id: "F123", name: "screenshot.png" },
          ]);
          await durability.runs.createOrResume({
            runId: "relayed-run",
            threadId: "slack-thread",
            startedAt: 1,
          });
          await durability.stream("relayed-run").append([
            {
              type: EventType.RUN_STARTED,
              runId: "relayed-run",
              threadId: "slack-thread",
              timestamp: 1,
            },
            {
              type: EventType.TOOL_CALL_START,
              toolCallId: "tool",
              toolName: "read_file",
              toolCallName: "read_file",
              timestamp: 2,
            },
            {
              type: EventType.TEXT_MESSAGE_START,
              messageId: "message",
              role: "assistant",
              timestamp: 3,
            },
            {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: "message",
              delta: "hello",
              timestamp: 4,
            },
            {
              type: EventType.RUN_FINISHED,
              runId: "relayed-run",
              threadId: "slack-thread",
              finishReason: "stop",
              timestamp: 5,
            },
          ]);
          await durability.runs.update("relayed-run", {
            status: "completed",
            finishedAt: 5,
          });
          await durability.stream("relayed-run").close();
          return { taskRunId: "task" };
        },
      }),
    },
  );

  assert.equal(result.result, "hello");
  assert.deepEqual(text, ["hello"]);
  assert.deepEqual(statuses, ["read_file"]);
  assert.equal(completed, 1);
});

test("fails promptly when the Workflow task dies before opening a log", async () => {
  const durability = await createAgentRunDurability({
    COMPADRE_DURABILITY_BACKEND: "memory",
  });
  assert.ok(durability);
  await assert.rejects(
    runWorkflowConversation(
      { prompt: "hello", provider: "claude-code" },
      {
        getDurability: async () => durability,
        createId: () => "missing-log",
        now: () => 1,
        getLauncher: () => ({
          async start() {
            return { taskRunId: "failed-task" };
          },
          async wait() {
            throw new Error("Workflow task failed during startup");
          },
        }),
      },
    ),
    /failed during startup/,
  );
  assert.equal((await durability.runs.get("missing-log"))?.status, "failed");
  const snapshot = await durability.stream("missing-log").snapshot();
  assert.equal(snapshot.at(-1)?.chunk.type, EventType.RUN_ERROR);
});

test("preserves launcher startup failure when durability finalization also fails", async (t) => {
  const durability = await createAgentRunDurability({
    COMPADRE_DURABILITY_BACKEND: "memory",
  });
  assert.ok(durability);
  durability.runs.get = async () => {
    throw new Error("finalization failed");
  };
  t.mock.method(console, "error", () => undefined);

  await assert.rejects(
    runWorkflowConversation(
      { prompt: "hello", provider: "claude-code" },
      {
        getDurability: async () => durability,
        createId: () => "startup-failure",
        now: () => 1,
        getLauncher: () => ({
          async start() {
            throw new Error("launcher startup failed");
          },
        }),
      },
    ),
    /launcher startup failed/,
  );
});
