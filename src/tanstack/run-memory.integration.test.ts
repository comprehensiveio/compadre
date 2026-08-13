import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  chat,
  EventType,
  normalizeSystemPrompts,
  type AnyTextAdapter,
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
import { deferTerminalHooks } from "./middleware-order.js";
import {
  metadataRunMemoryStore,
  withRunMemory,
  type RunMemoryRecord,
} from "./run-memory.js";

/**
 * Database-free lifecycle test in the conversation.integration.test.ts mold:
 * the in-memory persistence backend implements the same store contracts as
 * the Postgres deployment, and a scripted adapter emits the same passthrough
 * chunk sequences the Claude Code/Codex harness adapters produce.
 */

interface ScriptedTurn {
  answer: string;
  toolCallId: string;
  toolResult: string;
  reasoning?: string;
  sessionId?: string;
}

async function createTestSandbox(id: string): Promise<{
  sandbox: ReturnType<typeof defineSandbox>;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "compadre-run-memory-"));
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

function scriptedHarnessAdapter(turns: ScriptedTurn[]): {
  adapter: AnyTextAdapter;
  systemPromptsByTurn: Array<Array<string>>;
} {
  let nextTurn = 0;
  const systemPromptsByTurn: Array<Array<string>> = [];
  const adapter: AnyTextAdapter = {
    kind: "text",
    name: "scripted-harness",
    model: "scripted-model",
    requires: [SandboxCapability],
    "~types": undefined as never,
    async *chatStream(options: TextOptions<Record<string, never>>) {
      const turn = turns[nextTurn];
      nextTurn += 1;
      if (!turn) throw new Error("Scripted harness ran out of turns");
      systemPromptsByTurn.push(
        normalizeSystemPrompts(options.systemPrompts).map(
          (prompt) => prompt.content,
        ),
      );
      const runId = options.runId ?? `run-${nextTurn}`;
      const threadId = options.threadId ?? "thread";
      const timestamp = nextTurn * 100;
      yield {
        type: EventType.RUN_STARTED,
        runId,
        threadId,
        timestamp,
      } satisfies StreamChunk;
      if (turn.sessionId) {
        yield {
          type: EventType.CUSTOM,
          name: "claude-code.session-id",
          value: { sessionId: turn.sessionId, model: "scripted-model" },
          timestamp: timestamp + 1,
        } satisfies StreamChunk;
      }
      if (turn.reasoning) {
        yield {
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: `reasoning-${nextTurn}`,
          delta: turn.reasoning,
          timestamp: timestamp + 2,
        } satisfies StreamChunk;
      }
      yield {
        type: EventType.TOOL_CALL_START,
        toolCallId: turn.toolCallId,
        toolCallName: "read_logs",
        toolName: "read_logs",
        timestamp: timestamp + 3,
      } satisfies StreamChunk;
      yield {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: turn.toolCallId,
        delta: '{"service":"api"}',
        args: '{"service":"api"}',
        timestamp: timestamp + 4,
      } satisfies StreamChunk;
      yield {
        type: EventType.TOOL_CALL_END,
        toolCallId: turn.toolCallId,
        toolCallName: "read_logs",
        input: { service: "api" },
        timestamp: timestamp + 5,
      } satisfies StreamChunk;
      yield {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: turn.toolCallId,
        messageId: `tool-result-${nextTurn}`,
        content: turn.toolResult,
        timestamp: timestamp + 6,
      } satisfies StreamChunk;
      yield {
        type: EventType.TEXT_MESSAGE_START,
        messageId: `answer-${nextTurn}`,
        role: "assistant",
        timestamp: timestamp + 7,
      } satisfies StreamChunk;
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: `answer-${nextTurn}`,
        delta: turn.answer,
        content: turn.answer,
        timestamp: timestamp + 8,
      } satisfies StreamChunk;
      yield {
        type: EventType.TEXT_MESSAGE_END,
        messageId: `answer-${nextTurn}`,
        timestamp: timestamp + 9,
      } satisfies StreamChunk;
      yield {
        type: EventType.RUN_FINISHED,
        runId,
        threadId,
        finishReason: "stop",
        timestamp: timestamp + 10,
      } satisfies StreamChunk;
    },
    async structuredOutput() {
      throw new Error("Scripted harness does not support structured output");
    },
  };
  return { adapter, systemPromptsByTurn };
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _chunk of stream) {
    // Pull the complete stream so terminal middleware runs.
  }
}

/** Mirror createHarnessStream's middleware composition. */
async function runHarnessTurn(options: {
  adapter: AnyTextAdapter;
  persistence: ChatPersistence;
  prompt?: string;
  runId: string;
  sandbox: ReturnType<typeof defineSandbox>;
  sessionId?: string;
}): Promise<void> {
  const persistenceMiddleware = deferTerminalHooks(
    withPersistence(options.persistence),
  );
  const runMemory = withRunMemory(
    metadataRunMemoryStore(options.persistence.stores.metadata),
  );
  await drain(
    chat({
      adapter: options.adapter,
      messages: options.prompt
        ? [{ role: "user", content: options.prompt }]
        : [],
      systemPrompts: ["base system prompt"],
      middleware: [
        persistenceMiddleware.lifecycle,
        runMemory,
        withLocks(new InMemoryLockStore()),
        withSandbox(options.sandbox),
        persistenceMiddleware.terminal,
      ],
      threadId: "run-memory-thread",
      runId: options.runId,
      ...(options.sessionId
        ? { modelOptions: { sessionId: options.sessionId } }
        : {}),
      stream: true,
    }),
  );
}

test("run memory persists harness activity and projects it into fresh sessions", async (t) => {
  const persistence = memoryPersistence();
  const { adapter, systemPromptsByTurn } = scriptedHarnessAdapter([
    {
      answer: "first answer",
      toolCallId: "first-tool",
      toolResult: "42 errors in api logs",
      reasoning: "Check the api logs before answering.",
      sessionId: "native-session-1",
    },
    { answer: "second answer", toolCallId: "second-tool", toolResult: "two" },
    { answer: "third answer", toolCallId: "third-tool", toolResult: "three" },
  ]);
  const { sandbox, cleanup } = await createTestSandbox(
    "run-memory-integration-test",
  );
  t.after(cleanup);

  // Turn 1: brand-new thread. Nothing to inject yet.
  await runHarnessTurn({
    adapter,
    persistence,
    prompt: "how do the api logs look?",
    runId: "first-run",
    sandbox,
  });
  assert.deepEqual(systemPromptsByTurn[0], ["base system prompt"]);

  const stored = (await persistence.stores.metadata.get(
    "run-memory",
    "run-memory-thread",
  )) as Array<RunMemoryRecord>;
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.runId, "first-run");
  assert.equal(stored[0]?.status, "completed");
  assert.equal(stored[0]?.sessionId, "native-session-1");
  assert.equal(stored[0]?.reasoning, "Check the api logs before answering.");
  assert.deepEqual(stored[0]?.tools.map((tool) => tool.name), ["read_logs"]);
  assert.equal(stored[0]?.tools[0]?.resultPreview, "42 errors in api logs");

  // Turn 2: no native session (fresh host / provider switch) — digest injected.
  await runHarnessTurn({
    adapter,
    persistence,
    runId: "second-run",
    sandbox,
  });
  assert.equal(systemPromptsByTurn[1]?.length, 2);
  assert.equal(systemPromptsByTurn[1]?.[0], "base system prompt");
  const digest = systemPromptsByTurn[1]?.[1] ?? "";
  assert.ok(digest.includes("Prior agent activity"));
  assert.ok(digest.includes("first-run"));
  assert.ok(digest.includes("reasoning: Check the api logs before answering."));
  assert.ok(
    digest.includes('read_logs {"service":"api"} → ok: 42 errors in api logs'),
  );

  // Turn 3: resumed native session — no digest, session carries its history.
  await runHarnessTurn({
    adapter,
    persistence,
    runId: "third-run",
    sandbox,
    sessionId: "native-session-1",
  });
  assert.deepEqual(systemPromptsByTurn[2], ["base system prompt"]);

  const finalRecords = (await persistence.stores.metadata.get(
    "run-memory",
    "run-memory-thread",
  )) as Array<RunMemoryRecord>;
  assert.deepEqual(
    finalRecords.map((record) => record.runId),
    ["first-run", "second-run", "third-run"],
  );

  // The digest never leaks into canonical history: the message store holds
  // only conversation and sandbox-observed tool messages.
  const messages = await persistence.stores.messages.loadThread(
    "run-memory-thread",
  );
  for (const message of messages) {
    assert.ok(!String(message.content ?? "").includes("Prior agent activity"));
  }
});
