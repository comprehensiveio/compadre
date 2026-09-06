import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { WorkerTerminalRpc } from "./terminal-rpc.js";

test("worker terminal RPC multiplexes writes with attach, and detach interrupts only the reader", async () => {
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const frames: unknown[] = [];
  let interrupted!: () => void;
  const detached = new Promise<void>((resolve) => {
    interrupted = resolve;
  });
  server.on("connection", (socket, request) => {
    assert.equal(request.headers.authorization, "Bearer worker-secret");
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      frames.push(frame);
      if (frame._tag === "Request" && frame.tag === "terminal.attach")
        socket.send(
          JSON.stringify({
            _tag: "Chunk",
            requestId: frame.id,
            values: [{ type: "snapshot", snapshot: { history: "$ " } }],
          }),
        );
      if (frame._tag === "Request" && frame.tag === "terminal.write")
        socket.send(
          JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Success" } }),
        );
      if (frame._tag === "Interrupt" && frame.requestId === "1") interrupted();
    });
  });
  const rpc = new WorkerTerminalRpc(`http://127.0.0.1:${address.port}`, "worker-secret");
  try {
    const abort = new AbortController();
    const stream = rpc.request(
      "terminal.attach",
      { threadId: "native", terminalId: "term-1" },
      abort.signal,
    );
    assert.deepEqual((await stream.next()).value, {
      type: "snapshot",
      snapshot: { history: "$ " },
    });
    for await (const _ of rpc.request("terminal.write", { data: "pwd\n" }, abort.signal)) {
      /* void reply */
    }
    await stream.return(undefined);
    await detached;
    assert.equal(rpc.isClosed, false);
    assert.equal(
      frames.some((frame) => JSON.stringify(frame).includes("terminal.close")),
      false,
    );
  } finally {
    rpc.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
