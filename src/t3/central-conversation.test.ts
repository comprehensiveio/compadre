import assert from "node:assert/strict";
import test from "node:test";
import {
  centralT3DetailsUrl,
  centralT3ThreadId,
  isSlackEntrypointMessageId,
  runCentralT3Conversation,
  type CentralT3ConversationClient,
} from "./central-conversation.js";
import type {
  T3ModelSelection,
  T3OrchestrationSnapshot,
  T3Thread,
  T3ThreadSnapshot,
  T3TurnDispatch,
} from "./client.js";

const codex: T3ModelSelection = { instanceId: "codex", model: "gpt-5.6-sol" };

function thread(input: {
  id: string;
  modelSelection?: T3ModelSelection;
  messages?: T3Thread["messages"];
}): T3Thread {
  return {
    id: input.id,
    projectId: "project-central",
    title: "Slack request",
    modelSelection: input.modelSelection ?? codex,
    latestTurn: null,
    messages: input.messages ?? [],
    session: null,
  };
}

function terminalSnapshot(dispatch: T3TurnDispatch): T3ThreadSnapshot {
  return {
    snapshotSequence: dispatch.sequence + 5,
    thread: {
      ...thread({ id: dispatch.threadId }),
      latestTurn: {
        turnId: "turn-central",
        state: "completed",
        requestedAt: dispatch.createdAt,
        startedAt: dispatch.createdAt,
        completedAt: "2026-08-26T16:00:01.000Z",
        assistantMessageId: "assistant-final",
      },
      messages: [
        {
          id: dispatch.messageId,
          role: "user",
          text: "Question from Slack",
          turnId: "turn-central",
          streaming: false,
          createdAt: dispatch.createdAt,
          updatedAt: dispatch.createdAt,
        },
        {
          id: "assistant-update",
          role: "assistant",
          text: "I am checking.",
          turnId: "turn-central",
          streaming: false,
          createdAt: dispatch.createdAt,
          updatedAt: dispatch.createdAt,
        },
        {
          id: "assistant-final",
          role: "assistant",
          text: "The answer is 42.",
          turnId: "turn-central",
          streaming: false,
          createdAt: dispatch.createdAt,
          updatedAt: "2026-08-26T16:00:01.000Z",
        },
      ],
      session: {
        status: "ready",
        activeTurnId: null,
        lastError: null,
      },
      activities: [
        {
          id: "tool-current",
          kind: "tool.started",
          // Some provider activity arrives before the turn projection has
          // attached its turn id. Creation time still scopes it to this run.
          turnId: null,
          createdAt: dispatch.createdAt,
          summary: "Command run started",
          payload: {
            itemType: "command_execution",
            detail: "Bash: git status --short",
            data: { command: "git status --short" },
          },
        },
        {
          id: "tool-previous",
          kind: "tool.started",
          turnId: "turn-previous",
          summary: "Write started",
          payload: { detail: "Write: old.txt" },
        },
      ],
    },
  };
}

test("a Slack turn is created centrally and delivers only its final assistant message", async () => {
  const events: string[] = [];
  let dispatched: T3TurnDispatch | undefined;
  const attribution = {
    userId: "user-1",
    displayName: "Isaac",
    origin: "slack" as const,
    slack: {
      workspaceId: "T1",
      userId: "U1",
      channelId: "C1",
      messageTs: "123.4",
    },
  };
  const snapshot: T3OrchestrationSnapshot = {
    snapshotSequence: 3,
    projects: [
      {
        id: "project-central",
        title: "Compadre",
        workspaceRoot: "/var/data/workspace",
        defaultModelSelection: codex,
      },
    ],
    threads: [],
    updatedAt: "2026-08-26T16:00:00.000Z",
  };
  const client: CentralT3ConversationClient = {
    baseUrl: "https://central.example/",
    async environmentDescriptor() {
      return {
        environmentId: "environment-central",
        label: "Central",
        serverVersion: "0.0.33",
      };
    },
    async snapshot() {
      return snapshot;
    },
    async startNewThread(input) {
      events.push("dispatch");
      assert.equal(input.projectId, "project-central");
      assert.match(input.messageId ?? "", /^slack-entrypoint:/);
      assert.deepEqual(input.attribution, attribution);
      dispatched = {
        sequence: 10,
        commandId: "command-central",
        messageId: input.messageId!,
        threadId: input.threadId!,
        createdAt: "2026-08-26T16:00:00.000Z",
      };
      return dispatched;
    },
    async startTurn() {
      throw new Error("should create the thread");
    },
    async waitForTurnTerminal(input) {
      assert.ok(dispatched);
      const terminal = terminalSnapshot(dispatched);
      await input.onSnapshot?.(terminal);
      return terminal;
    },
  };
  const deltas: string[] = [];
  const toolStarts: string[] = [];
  const result = await runCentralT3Conversation({
    client,
    canonicalThreadId: "slack:T1:C1:123.4",
    title: "Slack request",
    prompt: "provider prompt",
    displayText: "Question from Slack",
    profile: "codex",
    idFactory: () => "message-1",
    attribution,
    onPrepared(prepared) {
      events.push("prepared");
      assert.equal(prepared.resumed, false);
    },
    onTextDelta(text) {
      deltas.push(text);
    },
    onToolStart(name) {
      toolStarts.push(name);
    },
  });

  assert.deepEqual(events, ["prepared", "dispatch"]);
  assert.equal(result.output, "The answer is 42.");
  assert.deepEqual(deltas, ["The answer is 42."]);
  assert.deepEqual(toolStarts, ["Bash"]);
  assert.equal(result.t3ThreadId, centralT3ThreadId("slack:T1:C1:123.4"));
  assert.equal(
    result.detailsUrl,
    `https://central.example/environment-central/${result.t3ThreadId}`,
  );
  assert.equal(result.environmentId, "environment-central");
  assert.equal(result.projectId, "project-central");
});

test("a Slack continuation follows the model already selected in the web UI", async () => {
  const threadId = centralT3ThreadId("slack:T1:C1:123.4");
  const claude: T3ModelSelection = {
    instanceId: "claudeAgent",
    model: "claude-opus-5",
  };
  let selection: T3ModelSelection | undefined;
  let dispatch: T3TurnDispatch | undefined;
  const client: CentralT3ConversationClient = {
    baseUrl: "https://central.example",
    async environmentDescriptor() {
      return {
        environmentId: "environment-central",
        label: "Central",
        serverVersion: "0.0.33",
      };
    },
    async snapshot() {
      return {
        snapshotSequence: 20,
        projects: [
          {
            id: "project-central",
            title: "Compadre",
            workspaceRoot: "/workspace",
            defaultModelSelection: codex,
          },
        ],
        threads: [thread({ id: threadId, modelSelection: claude })],
        updatedAt: "2026-08-26T16:00:00.000Z",
      };
    },
    async startNewThread() {
      throw new Error("should resume the existing thread");
    },
    async startTurn(input) {
      selection = input.modelSelection;
      dispatch = {
        sequence: 21,
        commandId: "command-2",
        messageId: input.messageId!,
        threadId: input.threadId,
        createdAt: "2026-08-26T16:00:00.000Z",
      };
      return dispatch;
    },
    async waitForTurnTerminal() {
      assert.ok(dispatch);
      const result = terminalSnapshot(dispatch);
      result.thread.modelSelection = claude;
      return result;
    },
  };

  const result = await runCentralT3Conversation({
    client,
    canonicalThreadId: "slack:T1:C1:123.4",
    title: "Slack request",
    prompt: "continue",
    profile: "codex",
    idFactory: () => "message-2",
  });

  assert.deepEqual(selection, claude);
  assert.equal(result.resumed, true);
});

test("central thread links and Slack source markers are explicit", () => {
  assert.equal(
    centralT3DetailsUrl({
      baseUrl: "https://central.example/base",
      environmentId: "environment 1",
      threadId: "thread 1",
    }),
    "https://central.example/environment%201/thread%201",
  );
  assert.equal(isSlackEntrypointMessageId("slack-entrypoint:message"), true);
  assert.equal(isSlackEntrypointMessageId("web-message"), false);
});
