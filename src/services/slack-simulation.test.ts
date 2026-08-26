import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationResult } from "../conversation.js";
import type { ConversationRunner } from "./conversation-runner.js";
import { runSlackSimulation } from "./slack-simulation.js";

function completedResult(output: string): ConversationResult {
  return {
    runId: "result-run",
    result: output,
    sessionId: "session",
    provider: "codex",
    model: "gpt-test",
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
    finishReason: "stop",
  };
}

test("simulates the real Slack-shaped Modal conversation without Slack I/O", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Slack simulation must not make network requests");
  };
  const runner: ConversationRunner = async (options) => {
    assert.equal(options.threadId, "1712345678.123456");
    assert.equal(options.profile, "codex");
    assert.equal(options.transcriptUserMessage, "Reply with SLACK-SIM-OK");
    assert.match(options.prompt, /User query:\nReply with SLACK-SIM-OK/);
    assert.match(options.prompt, /Thread context \(prior messages in this thread\):/);
    assert.match(options.prompt, /- channel: D_TEST/);
    assert.match(options.prompt, /- channel_name: direct-message/);
    options.stream?.onToolStart?.("read_file");
    options.stream?.onTextDelta?.("SLACK-SIM-OK");
    return completedResult("SLACK-SIM-OK");
  };

  try {
    const simulation = await runSlackSimulation({
      messageText: "--codex Reply with SLACK-SIM-OK",
      channel: "D_TEST",
      channelName: "direct-message",
      threadTs: "1712345678.123456",
      threadContext: "Isaac: prior message",
      userId: "U_TEST",
      runId: "simulation-run",
      runner,
    });

    assert.equal(simulation.output, "SLACK-SIM-OK");
    assert.deepEqual(simulation.tools, ["read_file"]);
    assert.deepEqual(simulation.runIds, ["simulation-run"]);
    assert.equal(simulation.outcome.autoContinued, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects conflicting Slack agent route directives before execution", async () => {
  let ran = false;
  await assert.rejects(
    runSlackSimulation({
      messageText: "--codex --claude-code investigate",
      runner: async () => {
        ran = true;
        return completedResult("unexpected");
      },
    }),
    /Choose one agent route/,
  );
  assert.equal(ran, false);
});
