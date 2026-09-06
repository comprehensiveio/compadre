import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

const decodeReply = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      ready: Schema.optionalKey(Schema.Boolean),
      ack: Schema.optionalKey(Schema.Number),
    }),
  ),
);
export type TerminalInputSocket = Pick<
  WebSocket,
  "addEventListener" | "send" | "close" | "bufferedAmount"
>;

function scheduleClose(milliseconds: number, close: () => void): () => void {
  const fiber = Effect.runFork(Effect.sleep(milliseconds).pipe(Effect.andThen(Effect.sync(close))));
  return () => {
    Effect.runFork(Fiber.interrupt(fiber));
  };
}

/** Ordered input over one socket; acknowledgments never block the next keystroke. */
export class CompadreTerminalInput {
  private socket: TerminalInputSocket;
  private ready: Promise<void>;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve(): void;
      reject(error: Error): void;
      bytes: number;
      timer: () => void;
    }
  >();
  private bytes = 0;
  private closed = false;
  private idle?: () => void;
  private handshake: () => void;
  private rejectReady!: (error: Error) => void;

  constructor(
    url: URL,
    token: string,
    target: { threadId: string; terminalId: string },
    createSocket: (url: URL) => TerminalInputSocket = (url) => new WebSocket(url),
  ) {
    this.socket = createSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.rejectReady = reject;
      this.socket.addEventListener("open", () =>
        this.socket.send(
          JSON.stringify({ token, threadId: target.threadId, terminalId: target.terminalId }),
        ),
      );
      this.socket.addEventListener("message", (event) => {
        try {
          const reply = decodeReply((event as MessageEvent).data);
          if (reply.ready) {
            this.handshake?.();
            resolve();
          }
          if (reply.ack !== undefined) {
            const pending = this.pending.get(reply.ack);
            if (!pending) return;
            pending.timer();
            this.pending.delete(reply.ack);
            this.bytes -= pending.bytes;
            pending.resolve();
            if (this.pending.size === 0) this.armIdle();
          }
        } catch {
          this.close();
        }
      });
    });
    void this.ready.catch(() => undefined);
    this.socket.addEventListener("error", () => this.close());
    this.socket.addEventListener("close", () => this.close());
    this.handshake = scheduleClose(15_000, () => this.close());
  }

  get isClosed() {
    return this.closed;
  }
  private armIdle() {
    this.idle?.();
    this.idle = scheduleClose(60_000, () => this.close());
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.handshake?.();
    this.idle?.();
    const error = new Error("Terminal input disconnected. Reopen the terminal to connect again.");
    this.rejectReady(error);
    for (const item of this.pending.values()) {
      item.timer();
      item.reject(error);
    }
    this.pending.clear();
    this.bytes = 0;
    this.socket.close();
  }
  async write(data: string): Promise<void> {
    await this.ready;
    if (this.closed) throw new Error("Terminal input is disconnected.");
    this.idle?.();
    const bytes = new TextEncoder().encode(data).byteLength;
    if (
      this.bytes + bytes > 256 * 1024 ||
      this.pending.size >= 4096 ||
      this.socket.bufferedAmount > 256 * 1024
    ) {
      this.close();
      throw new Error("Terminal input queue is full. Reopen the terminal to connect again.");
    }
    const seq = ++this.sequence;
    this.bytes += bytes;
    return new Promise<void>((resolve, reject) => {
      const timer = scheduleClose(30_000, () => this.close());
      this.pending.set(seq, { resolve, reject, bytes, timer });
      try {
        this.socket.send(JSON.stringify({ seq, data }));
      } catch {
        this.close();
      }
    });
  }
}
