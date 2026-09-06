import WebSocket from "ws";
import { z } from "zod";

const frameSchema = z.discriminatedUnion("_tag", [
  z.object({
    _tag: z.literal("Chunk"),
    requestId: z.union([z.string(), z.number()]),
    values: z.array(z.unknown()),
  }),
  z.object({
    _tag: z.literal("Exit"),
    requestId: z.union([z.string(), z.number()]),
    exit: z.discriminatedUnion("_tag", [
      z.object({ _tag: z.literal("Success"), value: z.unknown().optional() }),
      z.object({ _tag: z.literal("Failure"), cause: z.unknown() }),
    ]),
  }),
  z.object({ _tag: z.literal("Pong") }),
]);

/** A scoped worker RPC socket. Never retries/reconnects: worker acquisition owns that decision. */
export class WorkerTerminalRpc {
  private socket: WebSocket;
  private ready: Promise<void>;
  private nextId = 0;
  private pending = new Map<
    string,
    { accept(value: unknown): void; finish(error?: Error): void }
  >();
  private closed = false;
  private heartbeat: ReturnType<typeof setInterval>;
  private idle?: ReturnType<typeof setTimeout>;

  constructor(url: string, token: string) {
    const target = new URL("/ws", url);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(target, {
      headers: { authorization: `Bearer ${token}` },
      handshakeTimeout: 15_000,
      maxPayload: 2 * 1024 * 1024,
    });
    this.heartbeat = setInterval(() => {
      if (this.socket.readyState === WebSocket.OPEN)
        this.socket.send(JSON.stringify({ _tag: "Ping" }));
    }, 15_000);
    this.heartbeat.unref();
    this.ready = new Promise((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", () => reject(new Error("Worker terminal connection failed")));
      this.socket.once("close", () => reject(new Error("Worker terminal disconnected")));
    });
    void this.ready.catch(() => undefined);
    this.socket.on("error", () => this.close());
    this.socket.on("close", () => this.close());
    this.socket.on("message", (data) => {
      try {
        const raw: unknown = JSON.parse(data.toString());
        for (const entry of Array.isArray(raw) ? raw : [raw]) {
          const frame = frameSchema.parse(entry);
          if (frame._tag === "Pong") continue;
          const pending = this.pending.get(String(frame.requestId));
          if (!pending) continue;
          if (frame._tag === "Chunk") {
            for (const value of frame.values) pending.accept(value);
          } else {
            if (frame.exit._tag === "Success") {
              pending.accept(frame.exit.value);
              pending.finish();
            } else pending.finish(new Error("Worker terminal operation failed"));
          }
        }
      } catch {
        this.close();
      }
    });
  }

  get isClosed() {
    return this.closed;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idle);
    clearInterval(this.heartbeat);
    for (const entry of this.pending.values())
      entry.finish(new Error("Worker terminal disconnected. Reconnect to continue."));
    this.pending.clear();
    this.socket.terminate();
  }

  async *request(method: string, payload: object, signal: AbortSignal): AsyncGenerator<unknown> {
    await this.ready;
    if (this.closed) throw new Error("Worker terminal disconnected");
    signal.throwIfAborted();
    clearTimeout(this.idle);
    const id = String(++this.nextId);
    const queue: unknown[] = [];
    let bytes = 0;
    let done = false;
    let failure: Error | undefined;
    let wake: (() => void) | undefined;
    const finish = (error?: Error) => {
      done = true;
      failure = error;
      wake?.();
    };
    const abort = () => finish(new Error("Terminal request cancelled"));
    this.pending.set(id, {
      accept: (value) => {
        if (value === undefined) return;
        bytes += Buffer.byteLength(JSON.stringify(value));
        if (bytes > 2 * 1024 * 1024) {
          finish(new Error("Terminal reader is too slow. Reconnect to continue."));
          return;
        }
        queue.push(value);
        wake?.();
      },
      finish,
    });
    signal.addEventListener("abort", abort, { once: true });
    const timeout =
      method === "terminal.attach"
        ? undefined
        : setTimeout(() => finish(new Error("Terminal request timed out")), 30_000);
    this.socket.send(JSON.stringify({ _tag: "Request", id, tag: method, payload, headers: [] }));
    try {
      while (true) {
        while (queue.length) {
          const value = queue.shift();
          bytes -= Buffer.byteLength(JSON.stringify(value));
          yield value;
        }
        if (done) {
          if (failure) throw failure;
          return;
        }
        this.socket.send(JSON.stringify({ _tag: "Ack", requestId: id }));
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      this.pending.delete(id);
      if (!this.closed)
        this.socket.send(JSON.stringify({ _tag: "Interrupt", requestId: id, interruptors: [] }));
      if (this.pending.size === 0) {
        this.idle = setTimeout(() => this.close(), 30_000);
        this.idle.unref();
      }
    }
  }
}
