import assert from "node:assert/strict";
import test from "node:test";
import type { T3ThreadSnapshot, T3TurnDispatch } from "../t3/client.js";
import {
  deliverTriggeredPrompt,
  drainTriggeredPromptDeliveries,
  type TriggeredPromptBindings,
  type TriggeredPromptDeliveryDependencies,
  type TriggeredPromptSlack,
} from "./deliver.js";
import type { TriggeredPromptRecord } from "./types.js";

const TARGET_THREAD_ID = "6f76f496-6f37-4c4c-9e2f-000000000000";

function record(
  overrides: Partial<TriggeredPromptRecord>,
): TriggeredPromptRecord {
  return {
    id: "trigger-1",
    name: "Daily summary",
    prompt: "Summarize yesterday's merged PRs",
    triggerType: "cron",
    triggerConfig: { cronExpression: "0 9 * * *" },
    deliveryMode: "new_thread",
    slackChannelId: "C0123456789",
    enabled: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function terminalSnapshot(input: {
  threadId: string;
  messageId: string;
  answer: string;
}): T3ThreadSnapshot {
  return {
    snapshotSequence: 7,
    thread: {
      id: input.threadId,
      projectId: "project-1",
      modelSelection: { instanceId: "codex", model: "gpt-5.3-codex" },
      latestTurn: {
        turnId: "turn-1",
        state: "completed",
        requestedAt: "2026-09-01T09:00:00.000Z",
        startedAt: "2026-09-01T09:00:01.000Z",
        completedAt: "2026-09-01T09:00:30.000Z",
        assistantMessageId: "assistant-1",
      },
      messages: [
        {
          id: input.messageId,
          role: "user",
          text: "Summarize yesterday's merged PRs",
          turnId: "turn-1",
          createdAt: "2026-09-01T09:00:00.000Z",
        },
        {
          id: "assistant-1",
          role: "assistant",
          text: input.answer,
          turnId: "turn-1",
          createdAt: "2026-09-01T09:00:29.000Z",
        },
      ],
      session: { status: "idle", activeTurnId: null, lastError: null },
    },
  } as unknown as T3ThreadSnapshot;
}

interface FakeCalls {
  startTurn: Array<Record<string, unknown>>;
  startNewThread: Array<Record<string, unknown>>;
  posts: Array<{
    kind: string;
    channel: string;
    threadTs?: string;
    text: string;
    link?: string;
  }>;
  bindings: Array<Record<string, unknown>>;
  aliases: Array<{ alias: string; canonical: string }>;
}

function fakeDependencies(input: {
  existingThreads?: ReadonlyArray<Record<string, unknown>>;
  boundSlack?: { channelId: string; threadTs: string; recipientTeamId?: string };
  answer?: string;
}): { deps: TriggeredPromptDeliveryDependencies; calls: FakeCalls } {
  const calls: FakeCalls = {
    startTurn: [],
    startNewThread: [],
    posts: [],
    bindings: [],
    aliases: [],
  };
  const answer = input.answer ?? "Here is the summary.";
  const dispatchFor = (args: Record<string, unknown>): T3TurnDispatch => ({
    threadId: String(args.threadId),
    messageId: String(args.messageId),
    commandId: "command-1",
    sequence: 1,
    createdAt: "2026-09-01T09:00:00.000Z",
  });
  const client = {
    baseUrl: "https://compadre.example.io",
    async environmentDescriptor() {
      return { environmentId: "env-1" };
    },
    async snapshot() {
      return {
        threads: input.existingThreads ?? [],
        projects: [{ id: "project-1" }],
      };
    },
    async startNewThread(args: Record<string, unknown>) {
      calls.startNewThread.push(args);
      return dispatchFor(args);
    },
    async startTurn(args: Record<string, unknown>) {
      calls.startTurn.push(args);
      return dispatchFor(args);
    },
    async waitForTurnTerminal(args: { threadId: string; messageId?: string }) {
      return terminalSnapshot({
        threadId: args.threadId,
        messageId: args.messageId ?? "message-1",
        answer,
      });
    },
  } as unknown as TriggeredPromptDeliveryDependencies["client"];
  const slack: TriggeredPromptSlack = {
    async postMessage(channel, markdown, sessionLink) {
      calls.posts.push({
        kind: "root",
        channel,
        text: markdown,
        ...(sessionLink ? { link: sessionLink.url } : {}),
      });
      return { ok: true, ts: "1700000000.000100" };
    },
    async replyToThread(channel, threadTs, markdown, _clientMsgId, sessionLink) {
      calls.posts.push({
        kind: "reply",
        channel,
        threadTs,
        text: markdown,
        ...(sessionLink ? { link: sessionLink.url } : {}),
      });
      return { ok: true };
    },
  };
  const bindings: TriggeredPromptBindings = {
    async slack() {
      return input.boundSlack ?? null;
    },
    async bindSlack(threadId, binding) {
      calls.bindings.push({ threadId, ...binding });
    },
    async bindAlias(alias, canonical) {
      calls.aliases.push({ alias, canonical });
    },
  };
  return {
    deps: { client, slack, bindings, workspaceId: "T012345" },
    calls,
  };
}

test("new_thread fires post only the answer as a fresh Slack root and bind it", async () => {
  const { deps, calls } = fakeDependencies({});
  const result = await deliverTriggeredPrompt(record({}), deps);
  await drainTriggeredPromptDeliveries();

  assert.equal(result.delivery, "new_thread");
  assert.equal(calls.startNewThread.length, 1);
  const dispatched = calls.startNewThread[0]!;
  // The agent sees only the prompt; trigger provenance rides in attribution.
  assert.equal(dispatched.text, "Summarize yesterday's merged PRs");
  const attribution = dispatched.attribution as Record<string, unknown>;
  assert.equal(attribution.origin, "trigger");
  assert.equal(attribution.displayName, "Daily summary");
  assert.equal(
    (attribution.trigger as Record<string, unknown>).cronExpression,
    "0 9 * * *",
  );

  const root = calls.posts.find((post) => post.kind === "root");
  assert.ok(root);
  assert.equal(root.channel, "C0123456789");
  assert.equal(root.text, "Here is the summary.");
  assert.ok(!root.text.includes("Summarize yesterday's"));
  // The session link rides inside the answer message, not a second message.
  assert.ok(root.link?.includes("https://compadre.example.io"));
  assert.equal(calls.posts.length, 1);

  assert.equal(calls.bindings.length, 1);
  assert.equal(calls.bindings[0]!.channelId, "C0123456789");
  assert.equal(calls.bindings[0]!.threadTs, "1700000000.000100");
  assert.equal(calls.aliases.length, 1);
});

test("same_thread fires reply into the thread anchored by the first fire", async () => {
  const { deps, calls } = fakeDependencies({
    boundSlack: { channelId: "C0123456789", threadTs: "1699.42" },
  });
  const result = await deliverTriggeredPrompt(
    record({ deliveryMode: "same_thread" }),
    deps,
  );
  await drainTriggeredPromptDeliveries();

  assert.equal(result.delivery, "same_thread");
  const reply = calls.posts.find((post) => post.kind === "reply");
  assert.ok(reply);
  assert.equal(reply.threadTs, "1699.42");
  assert.equal(reply.text, "Here is the summary.");
  assert.ok(reply.link?.includes("https://compadre.example.io"));
  // Already anchored: no new root, no second message, no rebinding.
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.bindings.length, 0);
});

test("existing_thread fires into the target thread and reply when Slack-linked", async () => {
  const { deps, calls } = fakeDependencies({
    existingThreads: [
      {
        id: TARGET_THREAD_ID,
        modelSelection: { instanceId: "claudeAgent", model: "claude-fable-5" },
      },
    ],
    boundSlack: {
      channelId: "C0999",
      threadTs: "1699.99",
      recipientTeamId: "T012345",
    },
  });
  const result = await deliverTriggeredPrompt(
    record({
      deliveryMode: "existing_thread",
      slackChannelId: undefined,
      targetThreadId: TARGET_THREAD_ID,
    }),
    deps,
  );
  await drainTriggeredPromptDeliveries();

  assert.equal(result.centralThreadId, TARGET_THREAD_ID);
  assert.equal(calls.startTurn.length, 1);
  const dispatched = calls.startTurn[0]!;
  assert.equal(dispatched.threadId, TARGET_THREAD_ID);
  // Thread keeps its own provider/model selection.
  assert.deepEqual(dispatched.modelSelection, {
    instanceId: "claudeAgent",
    model: "claude-fable-5",
  });
  const reply = calls.posts.find((post) => post.kind === "reply");
  assert.equal(reply?.threadTs, "1699.99");
  assert.equal(reply?.text, "Here is the summary.");
  assert.ok(reply?.link?.includes("https://compadre.example.io"));
  assert.equal(calls.posts.length, 1);
});

test("existing_thread refuses a foreign-workspace Slack binding", async () => {
  const { deps } = fakeDependencies({
    existingThreads: [{ id: TARGET_THREAD_ID }],
    boundSlack: {
      channelId: "C0999",
      threadTs: "1699.99",
      recipientTeamId: "T-OTHER",
    },
  });
  await assert.rejects(
    deliverTriggeredPrompt(
      record({
        deliveryMode: "existing_thread",
        slackChannelId: undefined,
        targetThreadId: TARGET_THREAD_ID,
      }),
      deps,
    ),
    /foreign workspace/,
  );
});

test("existing_thread web-only threads run without posting to Slack", async () => {
  const { deps, calls } = fakeDependencies({
    existingThreads: [{ id: TARGET_THREAD_ID }],
  });
  await deliverTriggeredPrompt(
    record({
      deliveryMode: "existing_thread",
      slackChannelId: undefined,
      targetThreadId: TARGET_THREAD_ID,
    }),
    deps,
  );
  await drainTriggeredPromptDeliveries();
  assert.equal(calls.startTurn.length, 1);
  assert.equal(calls.posts.length, 0);
});

test("a failed turn posts one failure notice to the known Slack thread", async () => {
  const { deps, calls } = fakeDependencies({
    existingThreads: [{ id: TARGET_THREAD_ID }],
    boundSlack: { channelId: "C0999", threadTs: "1699.99" },
  });
  (deps.client as { waitForTurnTerminal: unknown }).waitForTurnTerminal =
    async () => {
      throw new Error("worker lost");
    };
  await deliverTriggeredPrompt(
    record({
      deliveryMode: "existing_thread",
      slackChannelId: undefined,
      targetThreadId: TARGET_THREAD_ID,
    }),
    deps,
  );
  await drainTriggeredPromptDeliveries();
  const reply = calls.posts.filter((post) => post.kind === "reply");
  assert.equal(reply.length, 1);
  assert.match(reply[0]!.text, /could not be completed/);
});
