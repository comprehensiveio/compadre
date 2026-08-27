import assert from "node:assert/strict";
import test from "node:test";
import { EventType, type StreamChunk } from "../t3/agui-protocol.js";
import {
  mirrorNativeT3RunToSlack,
  type NativeT3SlackDeliveryStream,
} from "./native-t3-slack-delivery.js";

async function* chunks(): AsyncIterable<StreamChunk> {
  yield {
    type: EventType.RUN_STARTED,
    runId: "run-1",
    threadId: "thread-1",
    timestamp: 1,
  };
  yield {
    type: EventType.TOOL_CALL_START,
    toolCallId: "tool-1",
    toolCallName: "github.get_repo",
    toolName: "github.get_repo",
    timestamp: 2,
  };
  yield {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: "assistant-1",
    delta: "Hello from the web",
    content: "Hello from the web",
    timestamp: 3,
  };
  yield {
    type: EventType.RUN_FINISHED,
    runId: "run-1",
    threadId: "thread-1",
    finishReason: "stop",
    timestamp: 4,
  };
}

test("a native web turn is mirrored into the bound Slack thread without changing its T3 stream", async () => {
  const calls: string[] = [];
  let text = "";
  const slack: NativeT3SlackDeliveryStream = {
    async postThreadMessage(message) {
      calls.push(`post:${message}`);
    },
    async postThreadContext(message) {
      calls.push(`context:${message}`);
    },
    async setStatus(status) {
      calls.push(`status:${status}`);
    },
    appendText(delta) {
      text += delta;
      return true;
    },
    async stopStream() {
      calls.push("stop");
    },
    async clearStatus() {
      calls.push("clear");
    },
  };
  const mirrored: StreamChunk[] = [];
  for await (const chunk of mirrorNativeT3RunToSlack(
    chunks(),
    {
      binding: { channelId: "C1", threadTs: "123.4" },
      userMessage: "Question from the browser",
      detailsUrl: "https://central.example/project/thread",
      botToken: "test-token",
    },
    slack,
  )) {
    mirrored.push(chunk);
  }

  assert.deepEqual(
    mirrored.map((chunk) => chunk.type),
    [
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.RUN_FINISHED,
    ],
  );
  assert.equal(text, "Hello from the web");
  assert.deepEqual(calls, [
    "post:*From Compadre web:*\nQuestion from the browser",
    "status:is thinking...",
    "status:is github.get_repo...",
    "stop",
    "context:<https://central.example/project/thread|Open in web>",
    "clear",
  ]);
});

test("a Slack delivery outage does not interrupt the central T3 stream", async () => {
  const slack: NativeT3SlackDeliveryStream = {
    async postThreadMessage() {
      throw new Error("Slack unavailable");
    },
    async postThreadContext() {},
    async setStatus() {},
    appendText() {
      throw new Error("should not append");
    },
    async stopStream() {},
    async clearStatus() {},
  };
  const mirrored: StreamChunk[] = [];
  for await (const chunk of mirrorNativeT3RunToSlack(
    chunks(),
    {
      binding: { channelId: "C1", threadTs: "123.4" },
      userMessage: "Question",
      botToken: "test-token",
    },
    slack,
  )) {
    mirrored.push(chunk);
  }
  assert.equal(mirrored.at(-1)?.type, EventType.RUN_FINISHED);
});
