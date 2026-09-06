import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { T3TerminalService, terminalRequestSchema } from "./terminal-service.js";
import { T3EnvironmentUnavailableError } from "./gateway.js";
import { createT3TerminalRoutes } from "../routes/t3-terminal.js";

test("subscriptions and every ordinary terminal operation cannot restore a stopped worker", async () => {
  let attached = 0;
  let started = 0;
  const service = new T3TerminalService({
    async attachWorker() {
      attached++;
      throw new T3EnvironmentUnavailableError("stopped");
    },
    async ensureWorkerRunning() {
      started++;
      return null;
    },
  });
  for (const operation of ["attach", "connection", "open", "write", "resize", "restart", "clear", "close"]) {
    const request = terminalRequestSchema.parse({
      operation,
      input: {
        threadId: "canonical",
        terminalId: "term-1",
        data: "pwd",
        cols: 80,
        rows: 24,
        startWorker: operation !== "open",
      },
    });
    await assert.rejects(service.connect(request), /Workspace is stopped/);
  }
  assert.equal(attached, 8);
  assert.equal(started, 0);
  await assert.rejects(
    service.connect({
      operation: "open",
      input: { threadId: "canonical", terminalId: "term-1", startWorker: true },
    }),
    /Start workspace/,
  );
  assert.equal(started, 1);
});

test("terminal route rejects unauthenticated and malformed operations before worker access", async () => {
  const old = process.env.COMPADRE_API_KEY;
  process.env.COMPADRE_API_KEY = "test-key";
  let acquired = 0;
  const service = new T3TerminalService({
    async attachWorker() {
      acquired++;
      return null;
    },
    async ensureWorkerRunning() {
      acquired++;
      return null;
    },
  });
  try {
    const app = createT3TerminalRoutes({ service });
    assert.equal(
      (await app.request("/hosted/t3/terminal", { method: "POST", body: "{}" })).status,
      401,
    );
    assert.equal(
      (
        await app.request("/hosted/t3/terminal", {
          method: "POST",
          headers: { authorization: "Bearer test-key", "content-type": "application/json" },
          body: JSON.stringify({ operation: "thread.turn.start", input: { threadId: "x" } }),
        })
      ).status,
      400,
    );
    assert.equal(acquired, 0);
  } finally {
    if (old === undefined) delete process.env.COMPADRE_API_KEY;
    else process.env.COMPADRE_API_KEY = old;
    service.close();
  }
});

test("terminal routing uses the worker directory, shares connections, and checkpoints explicit close", async () => {
  const { WebSocketServer } = await import("ws");
  const { WorkerTerminalRpc } = await import("./terminal-rpc.js");
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const frames: Array<{ tag: string; payload: Record<string, unknown> }> = [];
  server.on("connection", (socket) =>
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      if (frame._tag !== "Request") return;
      frames.push(frame);
      socket.send(
        JSON.stringify({
          _tag: "Exit",
          requestId: frame.id,
          exit: {
            _tag: "Success",
            value: { threadId: "native", snapshot: { threadId: "native" } },
          },
        }),
      );
    }),
  );
  let acquired = 0;
  let sockets = 0;
  let checkpoints = 0;
  const worker = {
    binding: { sandboxId: "worker", t3ThreadId: "native" },
    environment: {
      client: {
        async threadSnapshot() {
          return { thread: { projectId: "project", worktreePath: null } };
        },
        async snapshot() {
          return { projects: [{ id: "project", workspaceRoot: "/worker/workspace" }] };
        },
        createTerminalRpc() {
          sockets++;
          return new WorkerTerminalRpc(`http://127.0.0.1:${address.port}`, "secret");
        },
      },
    },
  } as unknown as NonNullable<
    Awaited<ReturnType<import("./gateway.js").T3Gateway["attachWorker"]>>
  >;
  const service = new T3TerminalService({
    async attachWorker() {
      acquired++;
      return worker;
    },
    async ensureWorkerRunning() {
      throw new Error("must not wake");
    },
    async checkpointWorkspace(id) {
      assert.equal(id, "canonical");
      checkpoints++;
    },
  });
  try {
    const request = terminalRequestSchema.parse({
      operation: "open",
      input: {
        threadId: "canonical",
        terminalId: "term-1",
        cwd: "/central",
        env: { SECRET: "do not forward" },
      },
    });
    const [connection, same] = await Promise.all([
      service.connect(request),
      service.connect(request),
    ]);
    assert.equal(connection, same);
    assert.equal(sockets, 1);
    assert.equal(await service.connect(request), connection);
    assert.equal(acquired, 2);
    const values = [];
    for await (const value of service.execute(request, connection, new AbortController().signal))
      values.push(value);
    assert.deepEqual(values, [{ threadId: "canonical", snapshot: { threadId: "canonical" } }]);
    assert.deepEqual(frames[0], {
      ...frames[0],
      tag: "terminal.open",
      payload: {
        threadId: "native",
        terminalId: "term-1",
        cwd: "/worker/workspace",
        worktreePath: null,
      },
    });
    for await (const _ of service.execute(
      { operation: "close", input: { threadId: "canonical", terminalId: "term-1" } },
      connection,
      new AbortController().signal,
    )) {
      /* drain */
    }
    assert.equal(checkpoints, 1);
  } finally {
    service.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("direct grants use the native terminal and trusted worker origin; old workers keep the relay", async () => {
  const service = new T3TerminalService({
    async attachWorker() { throw new Error("not needed after acquisition"); },
    async ensureWorkerRunning() { throw new Error("must never wake"); },
  });
  for (const supported of [false, true]) {
    const calls: Array<{ tag: string; payload: object }> = [];
    const connection = {
      nativeThreadId: "native", cwd: "/worker", sandboxId: "sandbox", baseUrl: "https://worker.example",
      rpc: { async *request(tag: string, payload: object) {
        calls.push({ tag, payload });
        yield tag === "server.getConfig"
          ? { environment: { capabilities: supported ? { directTerminals: true } : {} } }
          : { url: "/terminal/direct", ticket: "one-time", expiresAt: "2026-09-06T12:00:00Z" };
      } },
    } as unknown as Parameters<typeof service.execute>[1];
    const request = terminalRequestSchema.parse({ operation: "connection", input: { threadId: "canonical", terminalId: "bound", cwd: "/central", env: { SECRET: "no" }, startWorker: true } });
    const values = [];
    for await (const value of service.execute(request, connection, new AbortController().signal)) values.push(value);
    assert.equal(calls.length, supported ? 2 : 1);
    if (supported) {
      assert.deepEqual(values, [{ url: "wss://worker.example/terminal/direct", ticket: "one-time", expiresAt: "2026-09-06T12:00:00Z" }]);
      assert.deepEqual(calls[1]?.payload, { threadId: "native", terminalId: "bound", cwd: "/worker", worktreePath: null, startWorker: undefined, creation: undefined });
    } else assert.deepEqual(values, [null]);
  }
});
