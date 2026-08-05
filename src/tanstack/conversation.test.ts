import assert from "node:assert/strict";
import test from "node:test";
import { EventType, type StreamChunk } from "@tanstack/ai";
import { consumeHarnessConversation } from "./conversation.js";

async function* stream(...chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  yield* chunks;
}

test("translates AG-UI text, tools, session, and usage for channel callers", async () => {
  const text: string[] = [];
  const tools: string[] = [];
  let completed = 0;
  const result = await consumeHarnessConversation(
    stream(
      {
        type: EventType.CUSTOM,
        name: "codex.session-id",
        value: { sessionId: "codex-thread" },
        timestamp: 1,
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "message-1",
        role: "assistant",
        timestamp: 2,
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "message-1",
        delta: "hello",
        timestamp: 3,
      },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tool-1",
        toolCallName: "Read",
        toolName: "Read",
        timestamp: 4,
      },
      {
        type: EventType.RUN_FINISHED,
        threadId: "thread",
        runId: "run",
        model: "gpt-5.6-sol",
        finishReason: "stop",
        usage: {
          promptTokens: 1,
          completionTokens: 2,
          totalTokens: 3,
          providerUsageDetails: { totalCostUsd: 0.25 },
        },
        timestamp: 5,
      }
    ),
    {
      provider: "codex",
      startedAt: Date.now(),
      stream: {
        onTextDelta: (delta) => text.push(delta),
        onToolStart: (name) => tools.push(name),
        onComplete: () => {
          completed += 1;
        },
      },
    }
  );

  assert.equal(result.result, "hello");
  assert.equal(result.sessionId, "codex-thread");
  assert.equal(result.provider, "codex");
  assert.equal(result.model, "gpt-5.6-sol");
  assert.equal(result.costUsd, 0.25);
  assert.equal(result.numTurns, 1);
  assert.deepEqual(text, ["hello"]);
  assert.deepEqual(tools, ["Read"]);
  assert.equal(completed, 1);
});

test("surfaces AG-UI failures and still completes the channel stream", async () => {
  let completed = 0;
  await assert.rejects(
    consumeHarnessConversation(
      stream({
        type: EventType.RUN_ERROR,
        message: "provider failed",
        timestamp: 1,
      }),
      {
        provider: "claude-code",
        startedAt: Date.now(),
        stream: {
          onComplete: () => {
            completed += 1;
          },
        },
      }
    ),
    /provider failed/
  );
  assert.equal(completed, 1);
});

test("publishes only the terminal Codex message to channel callers", async () => {
  const text: string[] = [];
  const result = await consumeHarnessConversation(
    stream(
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "progress",
        role: "assistant",
        timestamp: 1,
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "progress",
        delta: "I'm inspecting the repository.",
        timestamp: 2,
      },
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "progress",
        timestamp: 3,
      },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tool-1",
        toolCallName: "Read",
        toolName: "Read",
        timestamp: 4,
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "final",
        role: "assistant",
        timestamp: 5,
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "final",
        delta: "COMPADRE_AGENT_RUNTIME",
        timestamp: 6,
      },
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "final",
        timestamp: 7,
      },
      {
        type: EventType.RUN_FINISHED,
        threadId: "thread",
        runId: "run",
        model: "gpt-5.6-sol",
        finishReason: "stop",
        timestamp: 8,
      }
    ),
    {
      provider: "codex",
      startedAt: Date.now(),
      stream: {
        onTextDelta: (delta) => text.push(delta),
      },
    }
  );

  assert.equal(result.result, "COMPADRE_AGENT_RUNTIME");
  assert.deepEqual(text, ["COMPADRE_AGENT_RUNTIME"]);
  assert.equal(result.numTurns, 2);
});

test("requires a terminal AG-UI event", async () => {
  await assert.rejects(
    consumeHarnessConversation(stream(), {
      provider: "codex",
      startedAt: Date.now(),
    }),
    /without a terminal event/
  );
});
