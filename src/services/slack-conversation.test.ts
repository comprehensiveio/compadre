import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type {
  ConversationOptions,
  ConversationResult,
} from "../conversation.js";
import type { ConversationRunner } from "./conversation-runner.js";
import {
  AUTO_CONTINUE_PROMPT,
  runSlackConversation,
} from "./slack-conversation.js";

function result(
  output: string,
  finishReason: ConversationResult["finishReason"],
): ConversationResult {
  return {
    runId: crypto.randomUUID(),
    result: output,
    sessionId: "session",
    provider: "claude-code",
    model: "claude-test",
    costUsd: 0,
    durationMs: 1,
    numTurns: 1,
    finishReason,
  };
}

test("automatically continues one incomplete run on the same thread", async () => {
  const attempts: ConversationOptions[] = [];
  const runner: ConversationRunner = async (options) => {
    attempts.push(options);
    if (attempts.length === 1) {
      options.stream?.onTextDelta?.("I'll investigate.");
      options.stream?.onToolStart?.("read_file");
      return result("I'll investigate.", "length");
    }
    options.stream?.onTextDelta?.("The final answer.");
    return result("The final answer.", "stop");
  };
  const delivered: string[] = [];
  let continuations = 0;

  const outcome = await runSlackConversation({
    runner,
    options: {
      runId: "first-run",
      prompt: "Investigate this",
      transcriptUserMessage: "Investigate this",
      threadId: "slack-thread",
    },
    delivery: {
      appendText(text) {
        delivered.push(text);
        return true;
      },
      hasTruncatedContent: () => false,
      onToolStart() {},
      onAutoContinue() {
        continuations += 1;
      },
    },
  });

  assert.equal(outcome.autoContinued, true);
  assert.equal(outcome.result.result, "The final answer.");
  assert.equal(outcome.result.durationMs, 2);
  assert.equal(outcome.result.numTurns, 2);
  assert.equal(continuations, 1);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.runId, "first-run");
  assert.equal(attempts[1]?.runId, undefined);
  assert.equal(attempts[1]?.threadId, "slack-thread");
  assert.equal(attempts[1]?.prompt, AUTO_CONTINUE_PROMPT);
  assert.deepEqual(delivered, ["I'll investigate.", "The final answer."]);
});

test("does not continue a complete first response", async () => {
  let attempts = 0;
  const outcome = await runSlackConversation({
    runner: async (options) => {
      attempts += 1;
      options.stream?.onTextDelta?.("Complete answer");
      return result("Complete answer", "stop");
    },
    options: { prompt: "Answer", threadId: "slack-thread" },
    delivery: {
      appendText: () => true,
      hasTruncatedContent: () => false,
      onToolStart() {},
      onAutoContinue() {
        assert.fail("complete responses must not continue");
      },
    },
  });

  assert.equal(attempts, 1);
  assert.equal(outcome.autoContinued, false);
});

test("does not continue content-filtered or Slack-truncated responses", async () => {
  for (const scenario of ["content-filter", "truncated"] as const) {
    let attempts = 0;
    await assert.rejects(
      runSlackConversation({
        runner: async (options) => {
          attempts += 1;
          options.stream?.onTextDelta?.("Partial answer");
          return result(
            "Partial answer",
            scenario === "content-filter" ? "content_filter" : "stop",
          );
        },
        options: { prompt: "Answer", threadId: "slack-thread" },
        delivery: {
          appendText: () => scenario !== "truncated",
          hasTruncatedContent: () => scenario === "truncated",
          onToolStart() {},
          onAutoContinue() {
            assert.fail(`${scenario} responses must not continue`);
          },
        },
      }),
      /without a complete terminal response/,
    );
    assert.equal(attempts, 1);
  }
});

test("does not continue if the continuation marker fills the Slack message", async () => {
  let attempts = 0;
  let truncated = false;
  await assert.rejects(
    runSlackConversation({
      runner: async (options) => {
        attempts += 1;
        options.stream?.onTextDelta?.("Partial answer");
        options.stream?.onToolStart?.("read_file");
        return result("Partial answer", "length");
      },
      options: { prompt: "Investigate", threadId: "slack-thread" },
      delivery: {
        appendText: () => true,
        hasTruncatedContent: () => truncated,
        onToolStart() {},
        onAutoContinue() {
          truncated = true;
        },
      },
    }),
    /without a complete terminal response/,
  );

  assert.equal(attempts, 1);
});

test("stops after one automatic continuation attempt", async () => {
  let attempts = 0;
  let continuations = 0;
  await assert.rejects(
    runSlackConversation({
      runner: async (options) => {
        attempts += 1;
        options.stream?.onTextDelta?.("Still investigating");
        options.stream?.onToolStart?.("read_file");
        return result("Still investigating", "length");
      },
      options: { prompt: "Investigate", threadId: "slack-thread" },
      delivery: {
        appendText: () => true,
        hasTruncatedContent: () => false,
        onToolStart() {},
        onAutoContinue() {
          continuations += 1;
        },
      },
    }),
    /without a complete terminal response/,
  );

  assert.equal(attempts, 2);
  assert.equal(continuations, 1);
});

test("does not automatically retry a thrown failure", async () => {
  let attempts = 0;
  await assert.rejects(
    runSlackConversation({
      runner: async () => {
        attempts += 1;
        throw new Error("Workflow task failed");
      },
      options: { prompt: "Investigate", threadId: "slack-thread" },
      delivery: {
        appendText: () => true,
        hasTruncatedContent: () => false,
        onToolStart() {},
        onAutoContinue() {
          assert.fail("thrown failures must not continue automatically");
        },
      },
    }),
    /Workflow task failed/,
  );
  assert.equal(attempts, 1);
});
