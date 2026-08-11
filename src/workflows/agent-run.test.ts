import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationResult } from "../conversation.js";
import {
  executeAgentWorkflow,
  executeRepositoryProbe,
  type AgentWorkflowDependencies,
} from "./agent-run.js";

const conversationResult: ConversationResult = {
  runId: "run-1",
  result: "hi",
  sessionId: "session-1",
  provider: "codex",
  model: "gpt-test",
  costUsd: 0,
  durationMs: 20,
  numTurns: 1,
  finishReason: "stop",
};

function dependencies(
  overrides: Partial<AgentWorkflowDependencies> = {},
): AgentWorkflowDependencies {
  let now = 0;
  return {
    ensureRepository() {},
    repositoryRevision: () => "abc123",
    runConversation: async (options) => {
      options.stream?.onTextDelta?.("hi");
      return conversationResult;
    },
    releaseThread: async () => {},
    now: () => (now += 10),
    createId: () => "generated-id",
    ...overrides,
  };
}

test("repository probe measures repository acquisition independently", async () => {
  let ensured = false;
  const result = await executeRepositoryProbe(
    dependencies({ ensureRepository: () => void (ensured = true) }),
  );

  assert.equal(ensured, true);
  assert.deepEqual(result, {
    repositoryRevision: "abc123",
    repositoryMs: 10,
    totalMs: 30,
  });
});

test("agent workflow runs the existing conversation stack after repository setup", async () => {
  const events: string[] = [];
  const result = await executeAgentWorkflow(
    {
      prompt: "say hi",
      threadId: "slack-thread",
      provider: "codex",
      maxTurns: 1,
    },
    dependencies({
      ensureRepository() {
        events.push("repository");
      },
      runConversation: async (options) => {
        events.push(`conversation:${options.threadId}:${options.provider}`);
        options.stream?.onTextDelta?.("hi");
        return conversationResult;
      },
      releaseThread: async (threadId) => {
        events.push(`release:${threadId}`);
      },
    }),
  );

  assert.deepEqual(events, [
    "repository",
    "conversation:slack-thread:codex",
    "release:slack-thread",
  ]);
  assert.equal(result.result, "hi");
  assert.equal(result.repositoryRevision, "abc123");
  assert.deepEqual(result.timings, {
    repositoryMs: 10,
    firstActivityMs: 40,
    agentMs: 20,
    totalMs: 50,
  });
});

test("agent workflow releases ephemeral thread state after a failure", async () => {
  const released: string[] = [];
  await assert.rejects(
    executeAgentWorkflow(
      { prompt: "fail" },
      dependencies({
        runConversation: async () => {
          throw new Error("agent failed");
        },
        releaseThread: async (threadId) => {
          released.push(threadId);
        },
      }),
    ),
    /agent failed/,
  );

  assert.deepEqual(released, ["workflow-generated-id"]);
});

test("agent workflow rejects malformed task input before starting work", async () => {
  let ensured = false;
  await assert.rejects(
    executeAgentWorkflow(
      { prompt: "" },
      dependencies({ ensureRepository: () => void (ensured = true) }),
    ),
  );
  assert.equal(ensured, false);
});
