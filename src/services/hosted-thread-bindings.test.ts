import assert from "node:assert/strict";
import test from "node:test";
import { memoryPersistence } from "@tanstack/ai-persistence";
import { HostedThreadBindingStore } from "./hosted-thread-bindings.js";

test("resolves a T3 thread alias to the Slack-backed canonical conversation", async () => {
  const persistence = memoryPersistence();
  const store = new HostedThreadBindingStore(
    persistence.stores.metadata,
  );

  await store.bindAlias("t3-thread", "1712345678.000100");

  assert.equal(await store.resolve("t3-thread"), "1712345678.000100");
  assert.equal(
    await store.resolve("1712345678.000100"),
    "1712345678.000100",
  );
});

test("keeps aliases stable instead of silently moving a workspace", async () => {
  const persistence = memoryPersistence();
  const store = new HostedThreadBindingStore(
    persistence.stores.metadata,
  );

  await store.bindAlias("t3-thread", "slack-thread-one");
  await store.bindAlias("t3-thread", "slack-thread-one");

  await assert.rejects(
    store.bindAlias("t3-thread", "slack-thread-two"),
    /already bound to slack-thread-one/,
  );
});
