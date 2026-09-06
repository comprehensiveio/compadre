import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import WebSocket from "ws";
import { installTerminalInput } from "./terminal-input.js";
import type { T3TerminalService } from "./terminal-service.js";

async function setup(service: Pick<T3TerminalService, "connect" | "execute">) {
  const server = createServer();
  const dispose = installTerminalInput(
    server,
    async () => service,
    () => "secret",
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/hosted/t3/terminal/input`);
  await once(socket, "open");
  return {
    socket,
    close: async () => {
      socket.terminate();
      dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("input authenticates before worker access and cannot request startup", async () => {
  let connects = 0;
  const fixture = await setup({
    async connect() {
      connects++;
      throw Error("must not acquire");
    },
    async *execute() {},
  });
  try {
    const closed = once(fixture.socket, "close");
    fixture.socket.send(
      JSON.stringify({
        token: "wrong",
        threadId: "canonical",
        terminalId: "term-1",
        startWorker: true,
      }),
    );
    await closed;
    assert.equal(connects, 0);
  } finally {
    await fixture.close();
  }
});

test("input batches a typing burst behind an in-flight write while preserving order", async () => {
  const writes: string[] = [];
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const firstDone = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await setup({
    async connect(request) {
      assert.deepEqual(request, {
        operation: "attach",
        input: { threadId: "canonical", terminalId: "term-1" },
      });
      return {} as Awaited<ReturnType<T3TerminalService["connect"]>>;
    },
    async *execute(request) {
      assert.equal(request.operation, "write");
      if (request.operation !== "write") return;
      writes.push(request.input.data);
      if (writes.length === 1) {
        started();
        await firstDone;
      }
    },
  });
  try {
    const ready = once(fixture.socket, "message");
    fixture.socket.send(
      JSON.stringify({
        token: "secret",
        threadId: "canonical",
        terminalId: "term-1",
        startWorker: true,
      }),
    );
    assert.deepEqual(JSON.parse(String((await ready)[0])), { ready: true });
    const acks: number[] = [];
    let finished!: () => void;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    fixture.socket.on("message", (raw) => {
      acks.push(JSON.parse(raw.toString()).ack);
      if (acks.length === 3) finished();
    });
    fixture.socket.send(JSON.stringify({ seq: 1, data: "a" }));
    await firstStarted;
    fixture.socket.send(JSON.stringify({ seq: 2, data: "b" }));
    fixture.socket.send(JSON.stringify({ seq: 3, data: "c" }));
    const pong = once(fixture.socket, "pong");
    fixture.socket.ping();
    await pong;
    assert.deepEqual(writes, ["a"]);
    release();
    await done;
    assert.deepEqual(writes, ["a", "bc"]);
    assert.deepEqual(acks, [1, 2, 3]);
  } finally {
    release();
    await fixture.close();
  }
});
