import assert from "node:assert/strict";
import test from "node:test";
import { memoryPersistence } from "@tanstack/ai-persistence";
import { createChannelConversationPersistence } from "./conversation.js";

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

  assert.deepEqual(await scoped.stores.messages.loadThread("thread"), [
    { role: "user", content: "enriched Slack prompt and metadata" },
  ]);
  await scoped.stores.messages.saveThread("thread", [
    { role: "user", content: "enriched Slack prompt and metadata" },
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

  assert.deepEqual(providerHistory, [
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
