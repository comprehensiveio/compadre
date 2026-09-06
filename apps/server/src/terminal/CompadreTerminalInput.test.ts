import { expect, it } from "vite-plus/test";
import { CompadreTerminalInput, type TerminalInputSocket } from "./CompadreTerminalInput.ts";

class Socket extends EventTarget {
  bufferedAmount = 0;
  sent: unknown[] = [];
  onSend: () => void = () => {};
  send(data: string) {
    this.sent.push(JSON.parse(data));
    this.onSend();
  }
  close() {
    this.dispatchEvent(new Event("close"));
  }
  reply(value: object) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
  open() {
    this.dispatchEvent(new Event("open"));
  }
}
const url = new URL("wss://controller.example/hosted/t3/terminal/input");
const target = { threadId: "canonical", terminalId: "term-1" };

it("sends ordered keystrokes without waiting for earlier acknowledgments", async () => {
  const socket = new Socket();
  const input = new CompadreTerminalInput(
    url,
    "secret",
    target,
    () => socket as unknown as TerminalInputSocket,
  );
  socket.open();
  expect(socket.sent).toEqual([{ token: "secret", ...target }]);
  socket.reply({ ready: true });
  let sent!: () => void;
  const bothSent = new Promise<void>((resolve) => {
    sent = resolve;
  });
  socket.onSend = () => {
    if (socket.sent.length === 3) sent();
  };
  const first = input.write("a");
  const second = input.write("b");
  await bothSent;
  expect(socket.sent.slice(1)).toEqual([
    { seq: 1, data: "a" },
    { seq: 2, data: "b" },
  ]);
  socket.reply({ ack: 1 });
  socket.reply({ ack: 2 });
  await Promise.all([first, second]);
  input.close();
});

it("disconnect rejects pending input without replaying characters", async () => {
  const socket = new Socket();
  const input = new CompadreTerminalInput(
    url,
    "secret",
    target,
    () => socket as unknown as TerminalInputSocket,
  );
  socket.open();
  socket.reply({ ready: true });
  socket.onSend = () => socket.close();
  await expect(input.write("secret command\n")).rejects.toThrow("disconnected");
  expect(socket.sent).toHaveLength(2);
  expect(input.isClosed).toBe(true);
});

it("bounds queued input while a worker is stalled", async () => {
  const socket = new Socket();
  const input = new CompadreTerminalInput(
    url,
    "secret",
    target,
    () => socket as unknown as TerminalInputSocket,
  );
  socket.open();
  socket.reply({ ready: true });
  await expect(input.write("a".repeat(256 * 1024 + 1))).rejects.toThrow("queue is full");
  expect(socket.sent).toHaveLength(1);
  expect(input.isClosed).toBe(true);
});
