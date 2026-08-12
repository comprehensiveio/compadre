import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  chat,
  EventType,
  type AnyTextAdapter,
  type ChatMiddleware,
  type ModelMessage,
  type StreamChunk,
  type TextOptions,
} from "@tanstack/ai";
import { withLocks, InMemoryLockStore } from "@tanstack/ai/locks";
import {
  memoryPersistence,
  withPersistence,
  type ChatPersistence,
} from "@tanstack/ai-persistence";
import {
  defineSandbox,
  defineWorkspace,
  SandboxCapability,
  type SandboxHandle,
  withSandbox,
} from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import { claudeCodeText } from "@tanstack/ai-claude-code";
import { createChannelConversationPersistence } from "./conversation.js";
import { deferTerminalHooks } from "../tanstack/middleware-order.js";

interface ScriptedTurn {
  answer: string;
  toolCallId: string;
  toolResult: string;
}

const EXPECTED_HISTORY = [
  {
    role: "user",
    content: "first prompt",
    toolCallId: undefined,
    toolCallIds: undefined,
  },
  {
    role: "assistant",
    content: null,
    toolCallId: undefined,
    toolCallIds: ["first-tool"],
  },
  {
    role: "tool",
    content: "one",
    toolCallId: "first-tool",
    toolCallIds: undefined,
  },
  {
    role: "assistant",
    content: "first answer",
    toolCallId: undefined,
    toolCallIds: undefined,
  },
  {
    role: "user",
    content: "second prompt",
    toolCallId: undefined,
    toolCallIds: undefined,
  },
  {
    role: "assistant",
    content: null,
    toolCallId: undefined,
    toolCallIds: ["second-tool"],
  },
  {
    role: "tool",
    content: "two",
    toolCallId: "second-tool",
    toolCallIds: undefined,
  },
  {
    role: "assistant",
    content: "second answer",
    toolCallId: undefined,
    toolCallIds: undefined,
  },
];

function projectHistory(messages: ReadonlyArray<ModelMessage>) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    toolCallId: message.toolCallId,
    toolCallIds: message.toolCalls?.map((call) => call.id),
  }));
}

/** Single-quote a shell word, escaping embedded single quotes POSIX-style. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function createTestSandbox(id: string): Promise<{
  sandbox: ReturnType<typeof defineSandbox>;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "compadre-persistence-"));
  let handle: SandboxHandle | undefined;
  return {
    sandbox: defineSandbox({
      id,
      provider: localProcessSandbox({ dir: directory, removeOnDestroy: false }),
      workspace: defineWorkspace({
        source: { type: "local", path: directory },
      }),
      lifecycle: {
        reuse: "thread",
        snapshot: "none",
        destroyOnComplete: false,
      },
      hooks: {
        onReady(readyHandle) {
          handle = readyHandle;
        },
      },
      fileEvents: false,
    }),
    cleanup: async () => {
      try {
        await handle?.destroy();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

function scriptedHarnessAdapter(turns: ScriptedTurn[]): AnyTextAdapter {
  let nextTurn = 0;
  return {
    kind: "text",
    name: "scripted-harness",
    model: "scripted-model",
    requires: [SandboxCapability],
    "~types": undefined as never,
    async *chatStream(options: TextOptions<Record<string, never>>) {
      const turn = turns[nextTurn];
      nextTurn += 1;
      if (!turn) throw new Error("Scripted harness ran out of turns");
      const runId = options.runId ?? `run-${nextTurn}`;
      const threadId = options.threadId ?? "thread";
      const timestamp = nextTurn * 100;
      yield {
        type: EventType.RUN_STARTED,
        runId,
        threadId,
        timestamp,
      } satisfies StreamChunk;
      yield {
        type: EventType.TOOL_CALL_START,
        toolCallId: turn.toolCallId,
        toolCallName: "read_logs",
        toolName: "read_logs",
        timestamp: timestamp + 1,
      } satisfies StreamChunk;
      yield {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: turn.toolCallId,
        delta: "{}",
        args: "{}",
        timestamp: timestamp + 2,
      } satisfies StreamChunk;
      yield {
        type: EventType.TOOL_CALL_END,
        toolCallId: turn.toolCallId,
        toolCallName: "read_logs",
        input: {},
        timestamp: timestamp + 3,
      } satisfies StreamChunk;
      yield {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: turn.toolCallId,
        messageId: `tool-result-${nextTurn}`,
        content: turn.toolResult,
        timestamp: timestamp + 4,
      } satisfies StreamChunk;
      yield {
        type: EventType.TEXT_MESSAGE_START,
        messageId: `answer-${nextTurn}`,
        role: "assistant",
        timestamp: timestamp + 5,
      } satisfies StreamChunk;
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: `answer-${nextTurn}`,
        delta: turn.answer,
        content: turn.answer,
        timestamp: timestamp + 6,
      } satisfies StreamChunk;
      yield {
        type: EventType.TEXT_MESSAGE_END,
        messageId: `answer-${nextTurn}`,
        timestamp: timestamp + 7,
      } satisfies StreamChunk;
      yield {
        type: EventType.RUN_FINISHED,
        runId,
        threadId,
        finishReason: "stop",
        timestamp: timestamp + 8,
      } satisfies StreamChunk;
    },
    async structuredOutput() {
      throw new Error("Scripted harness does not support structured output");
    },
  };
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _chunk of stream) {
    // Pull the complete stream so terminal middleware runs.
  }
}

async function runChannelTurn(options: {
  adapter: AnyTextAdapter;
  persistence: ChatPersistence;
  providerPrompt: string;
  transcriptPrompt: string;
  runId: string;
  sandbox: ReturnType<typeof defineSandbox>;
  resumesNativeSession: boolean;
  sessionId?: string;
  simulateTerminalMessageResync?: boolean;
}): Promise<void> {
  const threadId = "two-turn-thread";
  const scoped = await createChannelConversationPersistence(
    options.persistence,
    {
      threadId,
      providerMessages: [{ role: "user", content: options.providerPrompt }],
      transcriptUserMessage: options.transcriptPrompt,
      resumesNativeSession: options.resumesNativeSession,
    },
  );
  let messagesAtStart: ReadonlyArray<ModelMessage> = [];
  const terminalMessageResync: ChatMiddleware = {
    name: "simulate-terminal-message-resync",
    onStart(ctx) {
      messagesAtStart = ctx.messages;
    },
    onChunk(ctx, chunk) {
      if (chunk.type === EventType.RUN_FINISHED) {
        ctx.messages = messagesAtStart;
      }
    },
  };
  const persistenceMiddleware = deferTerminalHooks(withPersistence(scoped));
  await drain(
    chat({
      adapter: options.adapter,
      messages: [],
      middleware: [
        persistenceMiddleware.lifecycle,
        withLocks(new InMemoryLockStore()),
        withSandbox(options.sandbox),
        ...(options.simulateTerminalMessageResync
          ? [terminalMessageResync]
          : []),
        persistenceMiddleware.terminal,
      ],
      threadId,
      runId: options.runId,
      ...(options.sessionId
        ? { modelOptions: { sessionId: options.sessionId } }
        : {}),
      stream: true,
    }),
  );
}

test("persists complete tool-heavy history across two native harness turns", async (t) => {
  const persistence = memoryPersistence();
  const adapter = scriptedHarnessAdapter([
    { answer: "first answer", toolCallId: "first-tool", toolResult: "one" },
    { answer: "second answer", toolCallId: "second-tool", toolResult: "two" },
  ]);
  const { sandbox, cleanup } = await createTestSandbox(
    "conversation-lifecycle-test",
  );
  t.after(cleanup);

  await runChannelTurn({
    adapter,
    persistence,
    providerPrompt: "first prompt with channel context",
    transcriptPrompt: "first prompt",
    runId: "first-run",
    sandbox,
    resumesNativeSession: false,
  });
  await runChannelTurn({
    adapter,
    persistence,
    providerPrompt: "second prompt with channel context",
    transcriptPrompt: "second prompt",
    runId: "second-run",
    sandbox,
    resumesNativeSession: true,
  });

  const messages = await persistence.stores.messages.loadThread(
    "two-turn-thread",
  );
  assert.deepEqual(projectHistory(messages), EXPECTED_HISTORY);
});

test("persists complete history through the real Claude Code adapter lifecycle", async (t) => {
  const persistence = memoryPersistence();
  const fixtureSource = fileURLToPath(
    new URL("./fixtures/scripted-claude.mjs", import.meta.url),
  );
  const fixtureDirectory = await mkdtemp(
    join(tmpdir(), "compadre claude fixture "),
  );
  const executable = join(fixtureDirectory, "scripted claude.mjs");
  await copyFile(fixtureSource, executable);
  t.after(() => rm(fixtureDirectory, { recursive: true, force: true }));
  const adapter = claudeCodeText("claude-opus-5", {
    claudeExecutable: `${shellQuote(process.execPath)} ${shellQuote(executable)}`,
    emitDiff: false,
  });
  const { sandbox, cleanup } = await createTestSandbox(
    "claude-conversation-lifecycle-test",
  );
  t.after(cleanup);

  await runChannelTurn({
    adapter,
    persistence,
    providerPrompt: "first prompt with channel context",
    transcriptPrompt: "first prompt",
    runId: "claude-first-run",
    sandbox,
    resumesNativeSession: false,
  });
  await runChannelTurn({
    adapter,
    persistence,
    providerPrompt: "second prompt with channel context",
    transcriptPrompt: "second prompt",
    runId: "claude-second-run",
    sandbox,
    resumesNativeSession: true,
    sessionId: "scripted-session",
  });

  const messages = await persistence.stores.messages.loadThread(
    "two-turn-thread",
  );
  assert.deepEqual(projectHistory(messages), EXPECTED_HISTORY);
});

test("persists reconciled tool history after a terminal message resync", async (t) => {
  const persistence = memoryPersistence();
  const adapter = scriptedHarnessAdapter([
    { answer: "first answer", toolCallId: "first-tool", toolResult: "one" },
    { answer: "second answer", toolCallId: "second-tool", toolResult: "two" },
  ]);
  const { sandbox, cleanup } = await createTestSandbox(
    "terminal-resync-lifecycle-test",
  );
  t.after(cleanup);

  await runChannelTurn({
    adapter,
    persistence,
    providerPrompt: "first prompt with channel context",
    transcriptPrompt: "first prompt",
    runId: "resync-first-run",
    sandbox,
    resumesNativeSession: false,
  });
  await runChannelTurn({
    adapter,
    persistence,
    providerPrompt: "second prompt with channel context",
    transcriptPrompt: "second prompt",
    runId: "resync-second-run",
    sandbox,
    resumesNativeSession: true,
    simulateTerminalMessageResync: true,
  });

  const messages = await persistence.stores.messages.loadThread(
    "two-turn-thread",
  );
  assert.deepEqual(projectHistory(messages), EXPECTED_HISTORY);
});
