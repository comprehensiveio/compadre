import assert from "node:assert/strict";
import test from "node:test";
import { memoryPersistence } from "@tanstack/ai-persistence";
import { T3ThreadBindingStore } from "../services/t3-thread-bindings.js";
import {
  buildT3HostedThreadUrl,
  T3Gateway,
  type T3CommandClient,
  type T3EnvironmentConnectionManager,
} from "./gateway.js";

test("builds one-time hosted T3 links that retain the native thread target", () => {
  const url = new URL(
    buildT3HostedThreadUrl({
      hostedAppUrl: "https://t3-ui.example/",
      environmentUrl: "https://modal-thread.example/",
      pairingCredential: "secret-once",
      threadId: "t3-thread-1",
      label: "Slack request",
    }),
  );

  assert.equal(url.origin, "https://t3-ui.example");
  assert.equal(url.pathname, "/pair");
  assert.equal(url.searchParams.get("host"), "https://modal-thread.example/");
  assert.equal(url.searchParams.get("threadId"), "t3-thread-1");
  assert.equal(url.searchParams.get("label"), "Slack request");
  assert.equal(url.searchParams.has("token"), false);
  assert.equal(url.hash, "#token=secret-once");
});

test("routes model changes through the same provider-native T3 thread", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  const starts: string[] = [];
  const client: T3CommandClient = {
    baseUrl: "https://t3.example",
    async startNewThread(input) {
      starts.push(`new:${input.threadId}:${input.text}`);
      return {
        sequence: 10,
        commandId: "command-1",
        messageId: "message-1",
        threadId: input.threadId!,
        createdAt: "2026-08-26T15:00:00.000Z",
      };
    },
    async startTurn(input) {
      starts.push(`existing:${input.threadId}:${input.text}`);
      return {
        sequence: 20,
        commandId: "command-2",
        messageId: "message-2",
        threadId: input.threadId,
        createdAt: "2026-08-26T15:00:01.000Z",
      };
    },
    async interruptTurn() {
      return 30;
    },
    async waitForTurnTerminal() {
      throw new Error("unused");
    },
    async threadSnapshot() {
      throw new Error("unused");
    },
    async mintPairingCredential() {
      throw new Error("unused");
    },
  };
  const environments: T3EnvironmentConnectionManager = {
    async provision() {
      return { sandboxId: "sandbox-1", projectId: "project-1", client };
    },
    async reconnect() {
      return { sandboxId: "sandbox-1", projectId: "project-1", client };
    },
  };
  const gateway = new T3Gateway(
    bindings,
    environments,
    () => "t3-thread-1",
    () => new Date("2026-08-26T15:00:00.000Z"),
  );

  const selection = { instanceId: "codex", model: "gpt-5.6-sol" };
  const first = await gateway.send({
    canonicalThreadId: "slack-thread",
    title: "Slack request",
    text: "first",
    modelSelection: selection,
  });
  const second = await gateway.send({
    canonicalThreadId: "slack-thread",
    title: "Slack request",
    text: "second",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol-fast" },
  });

  assert.equal(first.binding.t3ThreadId, "t3-thread-1");
  assert.equal(second.binding.t3ThreadId, "t3-thread-1");
  assert.equal(second.binding.providerInstanceId, "codex");
  assert.deepEqual(starts, [
    "new:t3-thread-1:first",
    "existing:t3-thread-1:second",
  ]);
});

test("requires a new native T3 thread when switching provider harnesses", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  const client = {
    baseUrl: "https://t3.example",
    async startNewThread(input: { threadId?: string }) {
      return {
        sequence: 1,
        commandId: "command-1",
        messageId: "message-1",
        threadId: input.threadId!,
        createdAt: "2026-08-26T15:00:00.000Z",
      };
    },
    async startTurn() { throw new Error("unused"); },
    async interruptTurn() { throw new Error("unused"); },
    async waitForTurnTerminal() { throw new Error("unused"); },
    async threadSnapshot() { throw new Error("unused"); },
    async mintPairingCredential() { throw new Error("unused"); },
  } satisfies T3CommandClient;
  const gateway = new T3Gateway(
    bindings,
    {
      async provision() {
        return { sandboxId: "sandbox-1", projectId: "project-1", client };
      },
      async reconnect() {
        throw new Error("provider switch should fail before reconnect");
      },
    },
    () => "thread-1",
  );
  await gateway.send({
    canonicalThreadId: "slack-thread",
    title: "Question",
    text: "first",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
  });
  await assert.rejects(
    gateway.send({
      canonicalThreadId: "slack-thread",
      title: "Question",
      text: "second",
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
    }),
    /start a new thread/,
  );
});

test("cancel is a no-op until an external thread has a T3 binding", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  const environments: T3EnvironmentConnectionManager = {
    async provision() {
      throw new Error("unused");
    },
    async reconnect() {
      throw new Error("unused");
    },
  };
  const gateway = new T3Gateway(bindings, environments);
  assert.equal(
    await gateway.cancel({
      canonicalThreadId: "missing",
      providerInstanceId: "codex",
    }),
    null,
  );
});

test("discards a newly provisioned Modal environment when its first turn fails", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  const discarded: string[] = [];
  const client = {
    baseUrl: "https://t3.example",
    async startNewThread() {
      throw new Error("dispatch failed");
    },
    async startTurn() {
      throw new Error("unused");
    },
    async interruptTurn() {
      throw new Error("unused");
    },
    async waitForTurnTerminal() {
      throw new Error("unused");
    },
    async threadSnapshot() {
      throw new Error("unused");
    },
    async mintPairingCredential() {
      throw new Error("unused");
    },
  } satisfies T3CommandClient;
  const environments: T3EnvironmentConnectionManager = {
    async provision() {
      return { sandboxId: "sandbox-failed", projectId: "project-1", client };
    },
    async reconnect() {
      throw new Error("unused");
    },
    async discard(connection) {
      discarded.push(connection.sandboxId);
    },
  };
  const gateway = new T3Gateway(bindings, environments);
  await assert.rejects(
    gateway.send({
      canonicalThreadId: "slack-thread",
      title: "Failure",
      text: "fail",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    }),
    /dispatch failed/,
  );
  assert.deepEqual(discarded, ["sandbox-failed"]);
});
