import assert from "node:assert/strict";
import test from "node:test";
import type { T3ThreadSnapshot } from "../t3/client.js";
import {
  deliverClaimedSlackTurn,
  type SlackTurnDeliveryClient,
} from "./slack-turn-delivery.js";
import type { SlackTurnDelivery } from "./slack-turn-delivery-store.js";

const requestedAt = new Date("2026-08-29T12:00:00.000Z");

function delivery(): SlackTurnDelivery {
  return {
    id: "123e4567-e89b-42d3-a456-426614174000",
    messageId: "slack-entrypoint:message-1",
    canonicalThreadId: "slack:T1:C1:1.0",
    t3ThreadId: "thread-1",
    environmentId: "environment-1",
    dispatchSequence: 41,
    dispatchCreatedAt: requestedAt,
    slackTeamId: "T1",
    slackChannelId: "C1",
    slackThreadTs: "1.0",
    triggerMessageTs: "1.1",
    recipientUserId: "U1",
    detailsUrl: "https://compadre.example/environment-1/thread-1",
    status: "delivering",
    attempts: 1,
    nextAttemptAt: requestedAt,
    claimedAt: requestedAt,
    deliveredAt: null,
    lastError: null,
    createdAt: requestedAt,
    updatedAt: requestedAt,
  };
}

function snapshot(state: "completed" | "error" = "completed"): T3ThreadSnapshot {
  return {
    snapshotSequence: 50,
    thread: {
      id: "thread-1",
      projectId: "project-1",
      title: "Test",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      latestTurn: {
        turnId: "turn-1",
        state,
        requestedAt: requestedAt.toISOString(),
        startedAt: requestedAt.toISOString(),
        completedAt: requestedAt.toISOString(),
        assistantMessageId: "assistant-1",
      },
      messages: [
        {
          id: "slack-entrypoint:message-1",
          role: "user",
          text: "hello",
          turnId: "turn-1",
          streaming: false,
          createdAt: requestedAt.toISOString(),
          updatedAt: requestedAt.toISOString(),
        },
        {
          id: "assistant-1",
          role: "assistant",
          text: "Durable answer",
          turnId: "turn-1",
          streaming: false,
          createdAt: requestedAt.toISOString(),
          updatedAt: requestedAt.toISOString(),
        },
      ],
      session: {
        status: state === "error" ? "error" : "ready",
        activeTurnId: null,
        lastError: state === "error" ? "provider failed" : null,
      },
    },
  };
}

function slackRecorder() {
  const calls: Array<[string, ...unknown[]]> = [];
  const slack: SlackTurnDeliveryClient = {
    async postThreadMessage(...args) {
      calls.push(["message", ...args]);
    },
    async postThreadContext(...args) {
      calls.push(["context", ...args]);
    },
    async clearStatus() {
      calls.push(["clear"]);
    },
    async markRunSucceeded(...args) {
      calls.push(["succeeded", ...args]);
    },
    async markRunFailed(...args) {
      calls.push(["failed", ...args]);
    },
  };
  return { slack, calls };
}

test("delivers a recovered final answer with stable Slack idempotency keys", async () => {
  const job = delivery();
  const { slack, calls } = slackRecorder();
  const marked: string[] = [];
  const completed = await deliverClaimedSlackTurn({
    delivery: job,
    store: {
      async markDelivered(id) {
        marked.push(id.id);
        return true;
      },
      async markFailed() {
        assert.fail("delivery should not fail");
      },
    },
    t3: {
      baseUrl: "https://t3.example",
      async environmentDescriptor() {
        throw new Error("not used");
      },
      async snapshot() {
        throw new Error("not used");
      },
      async startNewThread() {
        throw new Error("not used");
      },
      async startTurn() {
        throw new Error("not used");
      },
      async waitForTurnTerminal(input) {
        assert.equal(input.messageId, job.messageId);
        assert.equal(input.minimumSequence, 41);
        return snapshot();
      },
    },
    slack,
  });
  assert.equal(completed, true);
  assert.deepEqual(marked, [job.id]);
  assert.deepEqual(calls[0], ["message", "Durable answer", job.id]);
  assert.equal(calls[1]?.[0], "context");
  assert.match(String(calls[1]?.[2]), /^[0-9a-f-]{36}$/);
  assert.deepEqual(calls.slice(2), [["clear"], ["succeeded", "1.1"]]);
});

test("keeps a transient T3 read failure pending instead of posting failure", async () => {
  const job = delivery();
  const { slack, calls } = slackRecorder();
  const failures: unknown[] = [];
  const completed = await deliverClaimedSlackTurn({
    delivery: job,
    store: {
      async markDelivered() {
        assert.fail("delivery should not complete");
      },
      async markFailed(_delivery, error) {
        failures.push(error);
      },
    },
    t3: {
      baseUrl: "https://t3.example",
      async environmentDescriptor() {
        throw new Error("not used");
      },
      async snapshot() {
        throw new Error("not used");
      },
      async startNewThread() {
        throw new Error("not used");
      },
      async startTurn() {
        throw new Error("not used");
      },
      async waitForTurnTerminal() {
        throw new Error("controller rollout");
      },
    },
    slack,
    logger: { info() {}, warn() {}, error() {} },
  });
  assert.equal(completed, false);
  assert.equal(failures.length, 1);
  assert.deepEqual(calls, []);
});

test("does not post when a newer worker owns the delivery claim", async () => {
  const job = delivery();
  const { slack, calls } = slackRecorder();
  let markedFailed = false;
  const completed = await deliverClaimedSlackTurn({
    delivery: job,
    store: {
      async renewClaim() {
        return false;
      },
      async markDelivered() {
        assert.fail("a stale claim must not complete");
      },
      async markFailed() {
        markedFailed = true;
      },
    },
    t3: {
      baseUrl: "https://t3.example",
      async environmentDescriptor() {
        throw new Error("not used");
      },
      async snapshot() {
        throw new Error("not used");
      },
      async startNewThread() {
        throw new Error("not used");
      },
      async startTurn() {
        throw new Error("not used");
      },
      async waitForTurnTerminal() {
        assert.fail("a stale claim must not wait for the agent");
      },
    },
    slack,
    logger: { info() {}, warn() {}, error() {} },
  });
  assert.equal(completed, false);
  assert.equal(markedFailed, false);
  assert.deepEqual(calls, []);
});
