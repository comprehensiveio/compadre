import assert from "node:assert/strict";
import test from "node:test";
import type {
  ChatMiddlewareConfig,
  ChatMiddlewareContext,
  ModelMessage,
} from "@tanstack/ai";
import { memoryPersistence } from "@tanstack/ai-persistence";
import { defineSandbox, withSandbox } from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import { createChannelConversationPersistence } from "./conversation.js";

function withoutMessageIds(messages: ModelMessage[]): ModelMessage[] {
  return messages.map(({ id: _id, ...message }) => message);
}

async function stripSandboxHistory(
  messages: ModelMessage[],
): Promise<ModelMessage[]> {
  const middleware = withSandbox(
    defineSandbox({
      id: "conversation-persistence-test",
      provider: localProcessSandbox(),
      fileEvents: false,
    }),
  );
  const config: ChatMiddlewareConfig = {
    messages,
    systemPrompts: [],
    tools: [],
  };
  const transformed = await middleware.onConfig?.(
    {} as ChatMiddlewareContext,
    config,
  );
  return transformed?.messages ?? messages;
}

test("persists neutral channel history while resuming a native session", async () => {
  const persistence = memoryPersistence();
  await persistence.stores.messages.saveThread("thread", [
    { role: "user", content: "earlier question" },
    { role: "assistant", content: "earlier answer" },
  ]);
  const scoped = await createChannelConversationPersistence(persistence, {
    threadId: "thread",
    providerMessages: [
      { role: "user", content: "enriched Slack prompt and metadata" },
    ],
    transcriptUserMessage: "follow-up question",
    resumesNativeSession: true,
  });

  const providerHistory = await scoped.stores.messages.loadThread("thread");
  assert.deepEqual(withoutMessageIds(providerHistory), [
    { role: "user", content: "enriched Slack prompt and metadata" },
  ]);
  await scoped.stores.messages.saveThread("thread", [
    ...providerHistory,
    { role: "assistant", content: "follow-up answer" },
  ]);

  assert.deepEqual(await persistence.stores.messages.loadThread("thread"), [
    { role: "user", content: "earlier question" },
    { role: "assistant", content: "earlier answer" },
    { role: "user", content: "follow-up question" },
    { role: "assistant", content: "follow-up answer" },
  ]);
});

test("replays canonical history to a fresh provider without persisting Slack context", async () => {
  const persistence = memoryPersistence();
  await persistence.stores.messages.saveThread("thread", [
    { role: "user", content: "earlier question" },
    { role: "assistant", content: "earlier answer" },
  ]);
  const scoped = await createChannelConversationPersistence(persistence, {
    threadId: "thread",
    providerMessages: [{ role: "user", content: "prompt plus Slack context" }],
    transcriptUserMessage: "new question",
    resumesNativeSession: false,
  });
  const providerHistory = await scoped.stores.messages.loadThread("thread");

  assert.deepEqual(withoutMessageIds(providerHistory), [
    { role: "user", content: "earlier question" },
    { role: "assistant", content: "earlier answer" },
    { role: "user", content: "prompt plus Slack context" },
  ]);
  await scoped.stores.messages.saveThread("thread", [
    ...providerHistory,
    { role: "assistant", content: "new answer" },
  ]);

  assert.deepEqual(await persistence.stores.messages.loadThread("thread"), [
    { role: "user", content: "earlier question" },
    { role: "assistant", content: "earlier answer" },
    { role: "user", content: "new question" },
    { role: "assistant", content: "new answer" },
  ]);
});

test("keeps current-turn output when sandbox middleware removes stored tool history", async () => {
  const persistence = memoryPersistence();
  const earlierToolCall: ModelMessage = {
    role: "assistant",
    content: null,
    toolCalls: [
      {
        id: "earlier-tool",
        type: "function",
        function: { name: "read_logs", arguments: "{}" },
        metadata: { sandboxObserved: true },
      },
    ],
  };
  await persistence.stores.messages.saveThread("thread", [
    { role: "user", content: "earlier question" },
    earlierToolCall,
    { role: "tool", toolCallId: "earlier-tool", content: "earlier result" },
    { role: "assistant", content: "earlier answer" },
  ]);
  const scoped = await createChannelConversationPersistence(persistence, {
    threadId: "thread",
    providerMessages: [{ role: "user", content: "prompt plus Slack context" }],
    transcriptUserMessage: "follow-up question",
    resumesNativeSession: false,
  });

  const providerHistory = await scoped.stores.messages.loadThread("thread");
  const modelHistory = await stripSandboxHistory(providerHistory);
  assert.equal(modelHistory.length, providerHistory.length - 2);

  await scoped.stores.messages.saveThread("thread", modelHistory);
  await scoped.stores.messages.saveThread("thread", [
    ...modelHistory,
    {
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: "current-tool",
          type: "function",
          function: { name: "read_logs", arguments: "{}" },
          metadata: { sandboxObserved: true },
        },
      ],
    },
    { role: "tool", toolCallId: "current-tool", content: "current result" },
    { role: "assistant", content: "follow-up answer" },
  ]);

  assert.deepEqual(await persistence.stores.messages.loadThread("thread"), [
    { role: "user", content: "earlier question" },
    earlierToolCall,
    { role: "tool", toolCallId: "earlier-tool", content: "earlier result" },
    { role: "assistant", content: "earlier answer" },
    { role: "user", content: "follow-up question" },
    {
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: "current-tool",
          type: "function",
          function: { name: "read_logs", arguments: "{}" },
          metadata: { sandboxObserved: true },
        },
      ],
    },
    { role: "tool", toolCallId: "current-tool", content: "current result" },
    { role: "assistant", content: "follow-up answer" },
  ]);
});
