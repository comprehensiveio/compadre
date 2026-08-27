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
    /automatically posts only your final assistant message/,
  );
  assert.match(input.prompt, /Working narration and tool-call text remain in the web UI/);
  assert.match(input.prompt, /one concise, self-contained final answer/);
  assert.match(input.prompt, /Do not use slack_post_message or slack_reply_to_thread/);
  assert.match(input.prompt, /deployment watches remain available/);
});
