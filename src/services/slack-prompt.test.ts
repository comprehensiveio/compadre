import assert from "node:assert/strict";
import test from "node:test";
import { buildSlackAgentInput } from "./slack-prompt.js";

test("keeps Slack delivery context out of the provider-neutral transcript", () => {
  const input = buildSlackAgentInput({
    messageText: "investigate this",
    threadContext: "<@U1>: earlier question\n<@U2>: earlier answer",
    channel: "C123",
    channelName: "#support",
    threadTs: "1234.5678",
    userId: "U3",
  });

  assert.equal(input.transcriptUserMessage, "investigate this");
  assert.match(input.prompt, /Thread context/);
  assert.match(input.prompt, /earlier answer/);
  assert.match(input.prompt, /slack_thread_url/);
  assert.match(
    input.prompt,
    /automatically streamed back to this Slack thread/,
  );
  assert.match(input.prompt, /Do not use a Slack tool to duplicate/);
});
