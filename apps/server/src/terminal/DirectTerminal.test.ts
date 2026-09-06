import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { NodeHttpServer } from "@effect/platform-node";
import { TerminalTickets, terminalTickets, directTerminalRouteLayer } from "./DirectTerminal.ts";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

import { TerminalManager } from "./Manager.ts";

it("binds a single-use grant to the original terminal and rejects expired grants", () => {
  let now = 100;
  const tickets = new TerminalTickets(() => now);
  const input = { threadId: "native", terminalId: "one", cwd: "/worker" };
  const grant = tickets.issue(input);
  input.terminalId = "other";
  expect(tickets.consume(grant.ticket)).toEqual({
    threadId: "native",
    terminalId: "one",
    cwd: "/worker",
  });
  expect(tickets.consume(grant.ticket)).toBeUndefined();
  const expired = tickets.issue(input);
  now += 30_000;
  expect(tickets.consume(expired.ticket)).toBeUndefined();
});

it.effect("direct sockets bind input to the ticket, stream output, and reject ticket replay", () =>
  Effect.gen(function* () {
    const writes: unknown[] = [];
    let attaches = 0;
    let detaches = 0;
    const manager = Layer.mock(TerminalManager)({
      attachStream: (input, listener) =>
        Effect.gen(function* () {
          attaches++;
          yield* listener({
            type: "snapshot",
            snapshot: {
              threadId: input.threadId,
              terminalId: input.terminalId,
              cwd: input.cwd!,
              worktreePath: null,
              status: "running",
              pid: 42,
              history: "ready",
              exitCode: null,
              exitSignal: null,
              label: "sh",
              updatedAt: "2026-09-06T00:00:00Z",
            },
          });
          return () => {
            detaches++;
          };
        }),
      write: (input) =>
        Effect.sync(() => {
          writes.push(input);
        }),
    });
    yield* Layer.build(
      HttpRouter.serve(directTerminalRouteLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.provide(manager)),
    );
    const server = yield* HttpServer.HttpServer;
    const address = server.address;
    if (address._tag !== "TcpAddress") throw new Error("Expected TCP server");
    const grant = terminalTickets.issue({
      threadId: "native",
      terminalId: "bound",
      cwd: "/worker",
    });
    yield* Effect.promise(async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/terminal/direct`);
      const messages: unknown[] = [];
      let next: (() => void) | undefined;
      socket.onmessage = ({ data }) => {
        messages.push(decode(String(data)));
        next?.();
      };
      const read = async () => {
        if (!messages.length)
          await new Promise<void>((resolve) => {
            next = resolve;
          });
        next = undefined;
        return messages.shift();
      };
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = reject;
      });
      socket.send(encode({ type: "connect", ticket: grant.ticket }));
      expect(await read()).toMatchObject({
        type: "event",
        sequence: 1,
        event: { type: "snapshot", snapshot: { terminalId: "bound" } },
      });
      socket.send(encode({ type: "ack", sequence: 1 }));
      socket.send(
        encode({
          type: "write",
          id: 1,
          data: "pwd\n",
          threadId: "other",
          terminalId: "other",
          startWorker: true,
        }),
      );
      expect(await read()).toEqual({ type: "ack", id: 1 });
      expect(writes).toEqual([{ threadId: "native", terminalId: "bound", data: "pwd\n" }]);
      await new Promise<void>((resolve) => {
        socket.onclose = () => resolve();
        socket.close();
      });
      const replay = new WebSocket(`ws://127.0.0.1:${address.port}/terminal/direct`);
      await new Promise<void>((resolve, reject) => {
        replay.onopen = () => replay.send(encode({ type: "connect", ticket: grant.ticket }));
        replay.onclose = () => resolve();
        replay.onerror = reject;
      });
    });
    expect(attaches).toBe(1);
    expect(detaches).toBeGreaterThanOrEqual(1);
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
