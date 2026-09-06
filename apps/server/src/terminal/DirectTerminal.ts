import * as NodeCrypto from "node:crypto";
import {
  TerminalDirectClientMessage,
  type TerminalAttachInput,
  type TerminalConnection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";
import { TerminalManager } from "./Manager.ts";

const TICKET_TTL = 30_000;
/** Grants are process-local, single-use and bound to one terminal and its trusted launch directory. */
export class TerminalTickets {
  private readonly tickets = new Map<string, { input: TerminalAttachInput; expires: number }>();
  private readonly now: () => number;
  constructor(now = Date.now) {
    this.now = now;
  }
  issue(input: TerminalAttachInput): TerminalConnection {
    const now = this.now();
    for (const [key, grant] of this.tickets) if (grant.expires <= now) this.tickets.delete(key);
    if (this.tickets.size >= 4096) throw new Error("Too many terminal connection requests");
    const ticket = NodeCrypto.randomBytes(32).toString("base64url");
    const expires = now + TICKET_TTL;
    this.tickets.set(ticket, { input: { ...input }, expires });
    return {
      url: "/terminal/direct",
      ticket,
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expires)),
    };
  }
  consume(ticket: string): TerminalAttachInput | undefined {
    const grant = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return grant && grant.expires > this.now() ? grant.input : undefined;
  }
}
export const terminalTickets = new TerminalTickets();
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(TerminalDirectClientMessage));
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const directTerminalRouteLayer = HttpRouter.add(
  "GET",
  "/terminal/direct",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const manager = yield* TerminalManager;
    const socket = yield* request.upgrade;
    const write = yield* socket.writer;
    const serial = yield* Semaphore.make(1);
    let target: TerminalAttachInput | undefined;
    let detach: (() => void) | undefined;
    let closed = false;
    let queued = 0;
    let lastId = 0;
    let sequence = 0;
    let unacknowledged = 0;
    const outstanding = new Map<number, number>();
    const close = Effect.gen(function* () {
      closed = true;
      detach?.();
      yield* write(new Socket.CloseEvent(1008, "Terminal connection ended"));
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true;
        detach?.();
      }),
    );
    yield* Effect.sleep("10 seconds").pipe(
      Effect.andThen(Effect.suspend(() => (target ? Effect.void : close))),
      Effect.forkScoped,
    );
    yield* Effect.sleep("1 hour").pipe(Effect.andThen(close), Effect.forkScoped);
    yield* socket.runString((data) => {
      if (closed) return Effect.void;
      if (data.length > 128 * 1024 || ++queued > 4096) return close;
      return serial
        .withPermit(
          Effect.gen(function* () {
            if (closed) return;
            const message = yield* Effect.try(() => decode(data));
            if (!target) {
              if (message.type !== "connect") return yield* close;
              target = terminalTickets.consume(message.ticket);
              if (!target) return yield* close;
              detach = yield* manager.attachStream(target, (event) =>
                Effect.gen(function* () {
                  if (closed) return;
                  const frame = encode({ type: "event", sequence: ++sequence, event });
                  const bytes = Buffer.byteLength(frame);
                  unacknowledged += bytes;
                  outstanding.set(sequence, bytes);
                  if (unacknowledged > 2 * 1024 * 1024 || outstanding.size > 4096)
                    return yield* close.pipe(Effect.ignore);
                  yield* write(frame).pipe(
                    Effect.catch(() => close),
                    Effect.ignore,
                  );
                }),
              );
              if (closed) detach();
              return;
            }
            if (message.type === "connect") return yield* close;
            if (message.type === "ping") return;
            if (message.type === "ack") {
              if (message.sequence > sequence) return yield* close;
              for (const [id, bytes] of outstanding)
                if (id <= message.sequence) {
                  outstanding.delete(id);
                  unacknowledged -= bytes;
                }
              return;
            }
            if (message.id <= lastId) return yield* close;
            lastId = message.id;
            if (message.type === "write")
              yield* manager.write({
                threadId: target.threadId,
                terminalId: target.terminalId,
                data: message.data,
              });
            else
              yield* manager.resize({
                threadId: target.threadId,
                terminalId: target.terminalId,
                cols: message.cols,
                rows: message.rows,
              });
            yield* write(encode({ type: "ack", id: message.id }));
          }),
        )
        .pipe(
          Effect.catch(() => close),
          Effect.ensuring(
            Effect.sync(() => {
              queued--;
            }),
          ),
        );
    });
    return HttpServerResponse.empty();
  }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 400 })))),
);
