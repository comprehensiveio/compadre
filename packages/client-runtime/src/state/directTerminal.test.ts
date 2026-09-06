import { describe, expect, it } from "vite-plus/test";
import { DirectTerminalConnection } from "./directTerminal.ts";

class FakeSocket {
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  bufferedAmount = 0;
  sent: Array<Record<string, unknown>> = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.onclose?.();
  }
  receive(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}
const grant = {
  url: "wss://worker.example/terminal/direct",
  ticket: "single-use",
  expiresAt: "2026-09-06T00:00:00Z",
};
const snapshot = {
  type: "event",
  sequence: 1,
  event: {
    type: "snapshot",
    snapshot: {
      threadId: "native",
      terminalId: "bound",
      cwd: "/worker",
      worktreePath: null,
      status: "running",
      pid: 42,
      history: "ready",
      exitCode: null,
      exitSignal: null,
      label: "sh",
      updatedAt: "2026-09-06T00:00:00Z",
    },
  },
};
function setup() {
  const socket = new FakeSocket();
  const events: unknown[] = [];
  let failures = 0;
  const connection = new DirectTerminalConnection(
    grant,
    { threadId: "canonical", terminalId: "bound" },
    (e) => events.push(e),
    () => failures++,
    () => socket as unknown as WebSocket,
  );
  socket.onopen?.();
  return { socket, connection, events, failures: () => failures };
}
describe("direct terminal input", () => {
  it("authenticates with a ticket and pipelines input without waiting for prior acknowledgments", async () => {
    const { socket, connection, events } = setup();
    try {
      expect(socket.sent).toEqual([{ type: "connect", ticket: "single-use" }]);
      socket.receive(snapshot);
      expect(events[0]).toMatchObject({ snapshot: { threadId: "canonical" } });
      socket.receive({
        type: "event",
        sequence: 2,
        event: {
          type: "restarted",
          threadId: "native",
          terminalId: "bound",
          createdAt: "2026-09-06T00:00:00Z",
          snapshot: snapshot.event.snapshot,
        },
      });
      expect(events[1]).toMatchObject({
        threadId: "canonical",
        snapshot: { threadId: "canonical" },
      });
      const a = connection.command({ type: "write", data: "a" });
      const b = connection.command({ type: "write", data: "b" });
      expect(socket.sent.slice(-2)).toEqual([
        { type: "write", id: 1, data: "a" },
        { type: "write", id: 2, data: "b" },
      ]);
      socket.receive({ type: "ack", id: 1 });
      socket.receive({ type: "ack", id: 2 });
      await Promise.all([a, b]);
    } finally {
      connection.close();
    }
  });
  it("rejects uncertain input on disconnect without replaying it", async () => {
    const { socket, connection, failures } = setup();
    socket.receive(snapshot);
    const pending = connection.command({ type: "write", data: "dangerous-to-repeat\n" });
    const rejected = expect(pending).rejects.toThrow("not replayed");
    socket.onclose?.();
    await rejected;
    expect(failures()).toBe(1);
    expect(connection.isReady).toBe(false);
    expect(socket.sent.filter((f) => f.type === "write")).toHaveLength(1);
  });
  it("fails closed on missing output and on excessive queued input", async () => {
    const first = setup();
    first.socket.receive({ ...snapshot, sequence: 2 });
    expect(first.failures()).toBe(1);
    const next = setup();
    next.socket.receive(snapshot);
    next.socket.bufferedAmount = 300_000;
    await expect(next.connection.command({ type: "write", data: "x" })).rejects.toThrow();
    expect(next.failures()).toBe(1);
  });
});
