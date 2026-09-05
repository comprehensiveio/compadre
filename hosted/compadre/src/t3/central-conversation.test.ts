import assert from "node:assert/strict";
import test from "node:test";
import {
  centralT3AbsoluteTimeoutMs,
  centralT3DetailsUrl,
  centralT3ThreadId,
  isSlackEntrypointMessageId,
  prependConversationContext,
  runCentralT3Conversation,
  type CentralT3ConversationClient,
} from "./central-conversation.js";
import type {
  T3InputFile,
  T3ModelSelection,
  T3OrchestrationSnapshot,
  T3Thread,
  T3ThreadSnapshot,
  T3TurnDispatch,
} from "./client.js";

const codex: T3ModelSelection = { instanceId: "codex", model: "gpt-5.6-sol" };

const currentImage: T3InputFile = {
  name: "current.png",
  mimetype: "image/png",
  sizeBytes: 3,
  dataBase64: "AQID",
};
const contextualImage: T3InputFile = {
  name: "earlier.png",
  mimetype: "image/png",
  sizeBytes: 2,
  dataBase64: "BAU=",
};

test("caps the central wait by the configured Modal worker lifetime", () => {
  assert.equal(centralT3AbsoluteTimeoutMs({}), 115 * 60 * 1_000);
  assert.equal(
    centralT3AbsoluteTimeoutMs({ COMPADRE_MODAL_TIMEOUT_MS: String(30 * 60 * 1_000) }),
    25 * 60 * 1_000,
  );
});

function thread(input: {
  id: string;
  modelSelection?: T3ModelSelection;
  messages?: T3Thread["messages"];
  latestTurn?: T3Thread["latestTurn"];
}): T3Thread {
  return {
    id: input.id,
    projectId: "project-central",
    title: "Slack request",
    modelSelection: input.modelSelection ?? codex,
    latestTurn: input.latestTurn ?? null,
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
      assert.equal(input.absoluteTimeoutMs, 25 * 60 * 1_000);
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
    environment: {
      COMPADRE_MODAL_TIMEOUT_MS: String(30 * 60 * 1_000),
    },
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

test("a Slack follow-up steers a running central turn without another terminal observer", async () => {
  const threadId = centralT3ThreadId("slack:T1:C1:active");
  let starts = 0;
  let waits = 0;
  const runningTurn: NonNullable<T3Thread["latestTurn"]> = {
    turnId: "turn-active",
    state: "running",
    requestedAt: "2026-09-05T16:00:00.000Z",
    startedAt: "2026-09-05T16:00:00.000Z",
    completedAt: null,
    assistantMessageId: "assistant-active",
  };
  const client: CentralT3ConversationClient = {
    baseUrl: "https://central.example",
    async environmentDescriptor() {
      return { environmentId: "environment-central", label: "Central", serverVersion: "1" };
    },
    async snapshot() {
      return {
        snapshotSequence: 11,
        projects: [],
        threads: [thread({ id: threadId, latestTurn: runningTurn })],
        updatedAt: "2026-09-05T16:00:01.000Z",
      };
    },
    async startNewThread() {
      throw new Error("should steer the existing thread");
    },
    async startTurn(input) {
      starts += 1;
      return {
        sequence: 12,
        commandId: "command-steer",
        messageId: input.messageId!,
        threadId: input.threadId,
        createdAt: "2026-09-05T16:00:02.000Z",
      };
    },
    async waitForTurnTerminal() {
      waits += 1;
      throw new Error("steering must not add another observer");
    },
  };

  const result = await runCentralT3Conversation({
    client,
    canonicalThreadId: "slack:T1:C1:active",
    title: "Follow-up",
    prompt: "Focus on cancellation",
    returnAfterSteer: true,
  });

  assert.equal(result.steered, true);
  assert.equal(result.output, "");
  assert.equal(starts, 1);
  assert.equal(waits, 0);
});

test("an interrupted central turn returns a continuation notice", async () => {
  let dispatch: T3TurnDispatch | undefined;
  const client: CentralT3ConversationClient = {
    baseUrl: "https://central.example",
    async environmentDescriptor() {
      return { environmentId: "environment-central", label: "Central", serverVersion: "1" };
    },
    async snapshot() {
      return {
        snapshotSequence: 1,
        projects: [{ id: "project-central", title: "Compadre", workspaceRoot: "/workspace", defaultModelSelection: codex }],
        threads: [],
        updatedAt: "2026-09-05T16:00:00.000Z",
      };
    },
    async startNewThread(input) {
      dispatch = {
        sequence: 2,
        commandId: "command-stop",
        messageId: input.messageId!,
        threadId: input.threadId!,
        createdAt: "2026-09-05T16:00:00.000Z",
      };
      return dispatch;
    },
    async startTurn() {
      throw new Error("not used");
    },
    async waitForTurnTerminal() {
      assert.ok(dispatch);
      const stopped = terminalSnapshot(dispatch);
      stopped.thread.latestTurn!.state = "interrupted";
      stopped.thread.messages = stopped.thread.messages.slice(0, 1);
      stopped.thread.session = { status: "interrupted", activeTurnId: null, lastError: null };
      return stopped;
    },
  };

  const result = await runCentralT3Conversation({
    client,
    canonicalThreadId: "slack:T1:C1:stopped",
    title: "Stop me",
    prompt: "Long task",
  });
  assert.equal(result.output, "Stopped. Send another message to continue.");
});

test("Slack history is hidden initial context only when creating a central thread", async () => {
  const prompts: string[] = [];
  let initialLoads = 0;
  let dispatch: T3TurnDispatch | undefined;
  const client: CentralT3ConversationClient = {
    baseUrl: "https://central.example",
    async environmentDescriptor() {
      return { environmentId: "environment-central", label: "Central", serverVersion: "1" };
    },
    async snapshot() {
      return {
        snapshotSequence: 1,
        projects: [{
          id: "project-central",
          title: "Compadre",
          workspaceRoot: "/workspace",
          defaultModelSelection: codex,
        }],
        threads: [],
        updatedAt: "2026-08-26T16:00:00.000Z",
      };
    },
    async startNewThread(input) {
      prompts.push(input.text);
      dispatch = {
        sequence: 2,
        commandId: "command-context",
        messageId: input.messageId!,
        threadId: input.threadId!,
        createdAt: "2026-08-26T16:00:00.000Z",
      };
      return dispatch;
    },
    async startTurn() {
      throw new Error("should create the thread");
    },
    async waitForTurnTerminal() {
      assert.ok(dispatch);
      return terminalSnapshot(dispatch);
    },
  };

  await runCentralT3Conversation({
    client,
    canonicalThreadId: "slack:T1:C1:context",
    title: "Investigate",
    prompt: "User query:\nInvestigate",
    displayText: "Investigate",
    loadInitialContext: async () => {
      initialLoads += 1;
      return "Thread context:\nSam: Earlier detail";
    },
  });

  assert.equal(initialLoads, 1);
  assert.equal(
    prompts[0],
    "Thread context:\nSam: Earlier detail\n\nUser query:\nInvestigate",
  );
});

test("a new central thread loads contextual Slack images once", async () => {
  let receivedFiles: ReadonlyArray<T3InputFile> | undefined;
  let inputLoads = 0;
  let dispatch: T3TurnDispatch | undefined;
  const client: CentralT3ConversationClient = {
    baseUrl: "https://central.example",
    async environmentDescriptor() {
      return { environmentId: "environment-central", label: "Central", serverVersion: "1" };
    },
    async snapshot() {
      return {
        snapshotSequence: 1,
        projects: [{ id: "project-central", title: "Compadre", workspaceRoot: "/workspace", defaultModelSelection: codex }],
        threads: [],
        updatedAt: "2026-08-26T16:00:00.000Z",
      };
    },
    async startNewThread(input) {
      receivedFiles = input.inputFiles;
      dispatch = {
        sequence: 2,
        commandId: "command-input-context",
        messageId: input.messageId!,
        threadId: input.threadId!,
        createdAt: "2026-08-26T16:00:00.000Z",
      };
      return dispatch;
    },
    async startTurn() {
      throw new Error("should create the thread");
    },
    async waitForTurnTerminal() {
      assert.ok(dispatch);
      return terminalSnapshot(dispatch);
    },
  };

  await runCentralT3Conversation({
    client,
    canonicalThreadId: "slack:T1:C1:new-with-images",
    title: "Investigate",
    prompt: "Investigate",
    inputFiles: [currentImage],
    loadInitialInputFiles: async () => {
      inputLoads += 1;
      return [contextualImage, currentImage];
    },
  });

  assert.equal(inputLoads, 1);
  assert.deepEqual(receivedFiles, [contextualImage, currentImage]);
});

test("a continuation uses current images unless explicit turn context overrides them", async () => {
  const threadId = centralT3ThreadId("slack:T1:C1:existing-with-images");
  const receivedFiles: Array<ReadonlyArray<T3InputFile> | undefined> = [];
  let initialLoads = 0;
  let dispatchSequence = 3;
  let dispatch: T3TurnDispatch | undefined;
  const client: CentralT3ConversationClient = {
    baseUrl: "https://central.example",
    async environmentDescriptor() {
      return { environmentId: "environment-central", label: "Central", serverVersion: "1" };
    },
    async snapshot() {
      return {
        snapshotSequence: 2,
        projects: [{ id: "project-central", title: "Compadre", workspaceRoot: "/workspace", defaultModelSelection: codex }],
        threads: [thread({ id: threadId })],
        updatedAt: "2026-08-26T16:00:00.000Z",
      };
    },
    async startNewThread() {
      throw new Error("should resume the thread");
    },
    async startTurn(input) {
      receivedFiles.push(input.inputFiles);
      dispatch = {
        sequence: dispatchSequence++,
        commandId: `command-input-${dispatchSequence}`,
        messageId: input.messageId!,
        threadId: input.threadId,
        createdAt: "2026-08-26T16:00:00.000Z",
      };
      return dispatch;
    },
    async waitForTurnTerminal() {
      assert.ok(dispatch);
      return terminalSnapshot(dispatch);
    },
  };

  const shared = {
    client,
    canonicalThreadId: "slack:T1:C1:existing-with-images",
    title: "Investigate",
    prompt: "Investigate",
    inputFiles: [currentImage],
    loadInitialInputFiles: async () => {
      initialLoads += 1;
      return [contextualImage, currentImage];
    },
  };
  await runCentralT3Conversation(shared);
  await runCentralT3Conversation({
    ...shared,
    loadTurnInputFiles: async () => [contextualImage, currentImage],
  });

  assert.equal(initialLoads, 0);
  assert.deepEqual(receivedFiles, [
    [currentImage],
    [contextualImage, currentImage],
  ]);
});

test("turn context is loaded for an existing central thread", async () => {
  const threadId = centralT3ThreadId("slack:T1:C1:mention-only");
  let prompt = "";
  let turnLoads = 0;
  let dispatch: T3TurnDispatch | undefined;
  const client: CentralT3ConversationClient = {
    baseUrl: "https://central.example",
    async environmentDescriptor() {
      return { environmentId: "environment-central", label: "Central", serverVersion: "1" };
    },
    async snapshot() {
      return {
        snapshotSequence: 3,
        projects: [{ id: "project-central", title: "Compadre", workspaceRoot: "/workspace", defaultModelSelection: codex }],
        threads: [thread({ id: threadId })],
        updatedAt: "2026-08-26T16:00:00.000Z",
      };
    },
    async startNewThread() {
      throw new Error("should resume the thread");
    },
    async startTurn(input) {
      prompt = input.text;
      dispatch = {
        sequence: 4,
        commandId: "command-turn-context",
        messageId: input.messageId!,
        threadId: input.threadId,
        createdAt: "2026-08-26T16:00:00.000Z",
      };
      return dispatch;
    },
    async waitForTurnTerminal() {
      assert.ok(dispatch);
      return terminalSnapshot(dispatch);
    },
  };

  await runCentralT3Conversation({
    client,
    canonicalThreadId: "slack:T1:C1:mention-only",
    title: "Respond to the preceding Slack message.",
    prompt: "Respond to the preceding Slack message.",
    loadInitialContext: async () => "must not load",
    loadTurnContext: async () => {
      turnLoads += 1;
      return "Thread context:\nSam: Can you investigate this?";
    },
  });

  assert.equal(turnLoads, 1);
  assert.equal(
    prompt,
    "Thread context:\nSam: Can you investigate this?\n\nRespond to the preceding Slack message.",
  );
});

test("conversation context stays within the provider prompt budget", () => {
  const prompt = "Question";
  const result = prependConversationContext("x".repeat(100_000), prompt);
  assert.equal(result.length, 95_000);
  assert.match(result, /^\[Earlier Slack thread context truncated/);
  assert.match(result, /\n\nQuestion$/);
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
