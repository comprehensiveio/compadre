import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { T3ThreadBinding } from "../services/t3-thread-bindings.js";
import type { T3ThreadSnapshot } from "../t3/client.js";
import type { T3GatewayTurn } from "../t3/gateway.js";
import {
  createT3DirectoryRoutes,
  type T3DirectoryRoutesDependencies,
} from "./t3-directory.js";

const binding: T3ThreadBinding = {
  canonicalThreadId: "thread-1",
  providerInstanceId: "codex",
  t3ThreadId: "native-thread-1",
  projectId: "project-1",
  sandboxId: "sandbox-secret",
  baseUrl: "https://sandbox.example",
  modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
  title: "Investigate the thing",
  status: "working",
  createdAt: "2026-08-26T15:00:00.000Z",
  updatedAt: "2026-08-26T15:00:01.000Z",
};

const snapshot: T3ThreadSnapshot = {
  snapshotSequence: 4,
  thread: {
    id: "native-thread-1",
    projectId: "project-1",
    title: "Investigate the thing",
    modelSelection: binding.modelSelection,
    latestTurn: {
      turnId: "turn-1",
      state: "completed",
      requestedAt: "2026-08-26T15:00:01.000Z",
      startedAt: "2026-08-26T15:00:01.000Z",
      completedAt: "2026-08-26T15:00:02.000Z",
      assistantMessageId: "assistant-1",
    },
    messages: [
      {
        id: "assistant-1",
        role: "assistant",
        text: "Done",
        turnId: "turn-1",
        streaming: false,
        createdAt: "2026-08-26T15:00:02.000Z",
        updatedAt: "2026-08-26T15:00:02.000Z",
      },
    ],
    session: { status: "ready", activeTurnId: null, lastError: null },
  },
};

function authorized(body?: unknown): RequestInit {
  return {
    ...(body === undefined
      ? {}
      : { method: "POST", body: JSON.stringify(body) }),
    headers: {
      Authorization: "Bearer test-key",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
  };
}

test("lists directory metadata without waking a T3 sandbox", async (t) => {
  const previousApiKey = process.env.COMPADRE_API_KEY;
  process.env.COMPADRE_API_KEY = "test-key";
  t.after(() => {
    if (previousApiKey === undefined) delete process.env.COMPADRE_API_KEY;
    else process.env.COMPADRE_API_KEY = previousApiKey;
  });

  let reconnects = 0;
  const dependencies: T3DirectoryRoutesDependencies = {
    enabled: () => true,
    createId: () => "generated-thread",
    watchTurn() {},
    async getGateway() {
      return {
        async list() {
          return [binding];
        },
        async send() {
          throw new Error("unused");
        },
        async snapshot() {
          reconnects += 1;
          throw new Error("unused");
        },
        async open() {
          reconnects += 1;
          throw new Error("unused");
        },
        async cancel() {
          reconnects += 1;
          throw new Error("unused");
        },
        async waitForTerminal() {
          throw new Error("unused");
        },
      };
    },
  };
  const app = new Hono();
  app.route("/", createT3DirectoryRoutes(dependencies));
  const response = await app.request("/hosted/t3/threads", authorized());

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    threads: Array<Record<string, unknown>>;
  };
  assert.equal(reconnects, 0);
  assert.equal(body.threads[0]?.canonicalThreadId, "thread-1");
  assert.equal(body.threads[0]?.sandboxId, undefined);
  assert.equal(body.threads[0]?.baseUrl, undefined);
});

test("creates, reads, sends, opens, and cancels one native T3 thread", async (t) => {
  const previousApiKey = process.env.COMPADRE_API_KEY;
  process.env.COMPADRE_API_KEY = "test-key";
  t.after(() => {
    if (previousApiKey === undefined) delete process.env.COMPADRE_API_KEY;
    else process.env.COMPADRE_API_KEY = previousApiKey;
  });

  const sends: Array<{ id: string; text: string }> = [];
  const watched: T3GatewayTurn[] = [];
  const gateway = {
    async list() {
      return [binding];
    },
    async send(input: {
      canonicalThreadId: string;
      text: string;
    }): Promise<T3GatewayTurn> {
      sends.push({ id: input.canonicalThreadId, text: input.text });
      return {
        binding: { ...binding, canonicalThreadId: input.canonicalThreadId },
        dispatch: {
          sequence: 3,
          commandId: "command-1",
          messageId: "message-1",
          threadId: "native-thread-1",
          createdAt: "2026-08-26T15:00:01.000Z",
        },
      };
    },
    async snapshot() {
      return { binding: { ...binding, status: "ready" as const }, snapshot };
    },
    async open() {
      return { binding, pairingUrl: "https://sandbox.example/pair#token=one-time" };
    },
    async cancel() {
      return 7;
    },
    async waitForTerminal() {
      return snapshot;
    },
  };
  const app = new Hono();
  app.route(
    "/",
    createT3DirectoryRoutes({
      enabled: () => true,
      createId: () => "generated-thread",
      getGateway: async () => gateway,
      watchTurn(_gateway, turn) {
        watched.push(turn);
      },
    }),
  );

  const created = await app.request(
    "/hosted/t3/threads",
    authorized({
      title: "New work",
      text: "first",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    }),
  );
  assert.equal(created.status, 202, await created.clone().text());
  assert.deepEqual(sends[0], { id: "generated-thread", text: "first" });

  const sent = await app.request(
    "/hosted/t3/threads/codex/thread-1/messages",
    authorized({
      text: "second",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    }),
  );
  assert.equal(sent.status, 202, await sent.clone().text());
  assert.deepEqual(sends[1], { id: "thread-1", text: "second" });
  assert.equal(watched.length, 2);

  const read = await app.request(
    "/hosted/t3/threads/codex/thread-1/snapshot",
    authorized(),
  );
  assert.equal(read.status, 200);
  assert.equal(((await read.json()) as { snapshot: T3ThreadSnapshot }).snapshot.thread.messages[0]?.text, "Done");

  const opened = await app.request(
    "/hosted/t3/threads/codex/thread-1/open",
    authorized({}),
  );
  assert.equal(opened.status, 200);
  assert.equal(
    ((await opened.json()) as { pairingUrl: string }).pairingUrl,
    "https://sandbox.example/pair#token=one-time",
  );

  const cancelled = await app.request(
    "/hosted/t3/threads/codex/thread-1/cancel",
    authorized({}),
  );
  assert.equal(cancelled.status, 200);
  assert.deepEqual(await cancelled.json(), { ok: true, sequence: 7 });
});

test("does not expose Modal bootstrap details when provisioning fails", async (t) => {
  const previousApiKey = process.env.COMPADRE_API_KEY;
  process.env.COMPADRE_API_KEY = "test-key";
  t.after(() => {
    if (previousApiKey === undefined) delete process.env.COMPADRE_API_KEY;
    else process.env.COMPADRE_API_KEY = previousApiKey;
  });

  const app = new Hono();
  app.route(
    "/",
    createT3DirectoryRoutes({
      enabled: () => true,
      createId: () => "generated-thread",
      watchTurn() {},
      async getGateway() {
        return {
          async list() { return []; },
          async send() {
            throw new Error("git clone failed with private repository details");
          },
          async snapshot() { throw new Error("unused"); },
          async open() { throw new Error("unused"); },
          async cancel() { throw new Error("unused"); },
          async waitForTerminal() { throw new Error("unused"); },
        };
      },
    }),
  );
  const response = await app.request(
    "/hosted/t3/threads",
    authorized({
      title: "Probe",
      text: "hello",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    }),
  );

  assert.equal(response.status, 502);
  const body = await response.text();
  assert.match(body, /T3 environment operation failed/);
  assert.doesNotMatch(body, /private repository details/);
});
