import assert from "node:assert/strict";
import test from "node:test";
import { EventType } from "@tanstack/ai";
import { createAgentRunDurability } from "../durability/runtime.js";
import {
  deliverHostedRunToSlack,
  type HostedSlackDeliveryStream,
} from "./hosted-slack-delivery.js";

test("Slack fanout waits through a cold browser-started run", async () => {
  const durability = await createAgentRunDurability({
    COMPADRE_DURABILITY_BACKEND: "memory",
  });
  assert.ok(durability);
  await durability.runs.createOrResume({
    runId: "slow-slack-run",
    threadId: "thread-1",
    startedAt: 1,
  });

  const posted: string[] = [];
  const statuses: string[] = [];
  const text: string[] = [];
  let stopped = false;
  const slack: HostedSlackDeliveryStream = {
    async postThreadMessage(markdown) {
      posted.push(markdown);
    },
    async setStatus(status) {
      statuses.push(status);
    },
    appendText(delta) {
      text.push(delta);
      return true;
    },
    async stopStream() {
      stopped = true;
    },
    async clearStatus() {
      statuses.push("");
    },
  };

  setTimeout(() => {
    void (async () => {
      await durability.stream("slow-slack-run").append([
        {
          type: EventType.RUN_STARTED,
          runId: "slow-slack-run",
          threadId: "thread-1",
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
          delta: "hello after startup",
          timestamp: 3,
        },
        {
          type: EventType.TEXT_MESSAGE_END,
          messageId: "assistant-message",
          timestamp: 4,
        },
        {
          type: EventType.RUN_FINISHED,
          runId: "slow-slack-run",
          threadId: "thread-1",
          finishReason: "stop",
          timestamp: 5,
        },
      ]);
      await durability.stream("slow-slack-run").close();
    })();
  }, 250);

  await deliverHostedRunToSlack(
    {
      binding: { channelId: "C123", threadTs: "1712345678.000100" },
      durability,
      runId: "slow-slack-run",
      provider: "codex",
      userMessage: "hello from web",
      botToken: "test-token",
    },
    slack,
  );

  assert.deepEqual(posted, ["*From Compadre web:*\nhello from web"]);
  assert.deepEqual(text, ["hello after startup"]);
  assert.equal(stopped, true);
  assert.deepEqual(statuses, ["is thinking...", ""]);
});
