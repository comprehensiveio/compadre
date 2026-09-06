import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import type { T3TerminalService } from "./terminal-service.js";

const authSchema = z.object({
  token: z.string(),
  threadId: z.string().min(1).max(200),
  terminalId: z.string().min(1).max(128),
});
const inputSchema = z.object({
  seq: z.number().int().positive(),
  data: z.string().min(1).max(65536),
});

/** Input acquisition is attach-only. No frame can provision or restore a worker. */
export function installTerminalInput(
  server: {
    on(
      event: "upgrade",
      listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
    ): unknown;
    off(
      event: "upgrade",
      listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
    ): unknown;
  },
  getService: () => Promise<Pick<T3TerminalService, "connect" | "execute"> | null>,
  apiKey: () => string | undefined = () => process.env.COMPADRE_API_KEY,
) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (request.url !== "/hosted/t3/terminal/input") {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit("connection", ws));
  };
  server.on("upgrade", upgrade);
  sockets.on("connection", (socket) => {
    const abort = new AbortController();
    let authenticating = false;
    let target: { threadId: string; terminalId: string } | undefined;
    let service: Pick<T3TerminalService, "connect" | "execute">;
    let connection: Awaited<ReturnType<T3TerminalService["connect"]>>;
    let lastSeq = 0;
    let queuedBytes = 0;
    let flushing = false;
    const queue: Array<{ seq: number; data: string }> = [];
    const close = () => {
      abort.abort();
      clearTimeout(timeout);
      queue.length = 0;
      socket.close(1011, "Terminal input disconnected");
    };
    const timeout = setTimeout(close, 15_000);
    timeout.unref();
    socket.on("close", () => {
      abort.abort();
      clearTimeout(timeout);
      queue.length = 0;
    });
    socket.on("error", close);
    const flush = async () => {
      if (flushing || !target) return;
      flushing = true;
      try {
        while (queue.length && !abort.signal.aborted) {
          const batch: Array<{ seq: number; data: string }> = [];
          let data = "";
          while (queue.length && data.length + queue[0]!.data.length <= 65536) {
            const item = queue.shift()!;
            queuedBytes -= Buffer.byteLength(item.data);
            batch.push(item);
            data += item.data;
          }
          for await (const _ of service.execute(
            { operation: "write", input: { ...target, data } },
            connection,
            abort.signal,
          )) {
            /* wait for this ordered batch */
          }
          if (socket.readyState === WebSocket.OPEN)
            for (const item of batch) socket.send(JSON.stringify({ ack: item.seq }));
        }
      } catch {
        close();
      } finally {
        flushing = false;
      }
    };
    socket.on("message", (raw) => {
      if (abort.signal.aborted) return;
      if (!target) {
        if (authenticating) {
          close();
          return;
        }
        authenticating = true;
        void (async () => {
          const auth = authSchema.parse(JSON.parse(raw.toString()));
          const expected = apiKey();
          if (!expected || auth.token !== expected) {
            close();
            return;
          }
          const configured = await getService();
          if (!configured) {
            close();
            return;
          }
          service = configured;
          connection = await service.connect({
            operation: "attach",
            input: { threadId: auth.threadId, terminalId: auth.terminalId },
          });
          if (abort.signal.aborted) return;
          target = { threadId: auth.threadId, terminalId: auth.terminalId };
          clearTimeout(timeout);
          socket.send(JSON.stringify({ ready: true }));
        })().catch(close);
        return;
      }
      try {
        const input = inputSchema.parse(JSON.parse(raw.toString()));
        if (input.seq !== lastSeq + 1) {
          close();
          return;
        }
        lastSeq = input.seq;
        queuedBytes += Buffer.byteLength(input.data);
        if (queuedBytes > 256 * 1024 || queue.length >= 4096) {
          close();
          return;
        }
        queue.push(input);
        void flush();
      } catch {
        close();
      }
    });
  });
  return () => {
    server.off("upgrade", upgrade);
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
  };
}
