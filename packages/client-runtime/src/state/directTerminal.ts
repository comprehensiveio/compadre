import {
  TerminalDirectServerMessage,
  TerminalRemoteError,
  WS_METHODS,
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
  type TerminalConnection,
  type TerminalMetadataStreamEvent,
  type TerminalSummary,
  type TerminalWriteInput,
  type TerminalResizeInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { request, subscribe } from "../rpc/client.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(TerminalDirectServerMessage));
const disconnected = () =>
  new TerminalRemoteError({ message: "Terminal connection interrupted. Input was not replayed." });
const timer = (ms: number, run: () => void) => {
  const fiber = Effect.runFork(Effect.sleep(ms).pipe(Effect.andThen(Effect.sync(run))));
  return () => {
    Effect.runFork(Fiber.interrupt(fiber));
  };
};

/** One attach-only connection; uncertain writes are rejected, never replayed on the relay. */
export class DirectTerminalConnection {
  private readonly socket: WebSocket;
  private readonly pending = new Map<
    number,
    { resolve(): void; reject(error: TerminalRemoteError): void; cancel(): void; bytes: number }
  >();
  private nextId = 0;
  private bytes = 0;
  private lastSequence = 0;
  private closed = false;
  private ready = false;
  private readonly cancelHandshake: () => void;
  private cancelHeartbeat: () => void = () => {};
  private readonly event: (event: TerminalAttachStreamEvent) => void;
  private readonly failed: () => void;
  constructor(
    grant: TerminalConnection,
    input: TerminalAttachInput,
    event: (event: TerminalAttachStreamEvent) => void,
    failed: () => void,
    createSocket = (url: string) => new WebSocket(url),
  ) {
    this.event = event;
    this.failed = failed;
    const url = new URL(grant.url);
    if (
      url.protocol !== "wss:" &&
      !(url.protocol === "ws:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      throw disconnected();
    this.socket = createSocket(url.toString());
    this.cancelHandshake = timer(8_000, () => this.close());
    this.socket.onopen = () => {
      if (this.closed) return;
      try {
        this.socket.send(encode({ type: "connect", ticket: grant.ticket }));
      } catch {
        this.close();
      }
    };
    this.socket.onerror = () => this.close();
    this.socket.onclose = () => this.close();
    this.socket.onmessage = ({ data }) => {
      if (this.closed) return;
      try {
        if (typeof data !== "string" || data.length > 2 * 1024 * 1024) throw disconnected();
        const message = decode(data);
        if (message.type === "error") throw disconnected();
        if (message.type === "ack") {
          const pending = this.pending.get(message.id);
          if (!pending) throw disconnected();
          this.pending.delete(message.id);
          this.bytes -= pending.bytes;
          pending.cancel();
          pending.resolve();
          return;
        }
        if (message.sequence !== this.lastSequence + 1) throw disconnected();
        this.lastSequence = message.sequence;
        const original = message.event;
        const event: TerminalAttachStreamEvent =
          "snapshot" in original
            ? {
                ...original,
                ...("threadId" in original
                  ? { threadId: input.threadId, terminalId: input.terminalId }
                  : {}),
                snapshot: {
                  ...original.snapshot,
                  threadId: input.threadId,
                  terminalId: input.terminalId,
                },
              }
            : { ...original, threadId: input.threadId, terminalId: input.terminalId };
        if (!this.ready && event.type !== "snapshot") throw disconnected();
        if (event.type === "snapshot") {
          this.ready = true;
          this.cancelHandshake();
          this.heartbeat();
        }
        this.event(event);
        if (!this.closed) this.socket.send(encode({ type: "ack", sequence: message.sequence }));
      } catch {
        this.close();
      }
    };
  }
  private heartbeat() {
    this.cancelHeartbeat();
    this.cancelHeartbeat = timer(15_000, () => {
      if (!this.closed) {
        this.socket.send(encode({ type: "ping" }));
        this.heartbeat();
      }
    });
  }
  get isReady() {
    return this.ready && !this.closed;
  }
  command(
    message: { type: "write"; data: string } | { type: "resize"; cols: number; rows: number },
  ): Promise<void> {
    if (!this.isReady) return Promise.reject(disconnected());
    const id = ++this.nextId;
    const frame = encode({ ...message, id });
    const bytes = new TextEncoder().encode(frame).length;
    if (
      this.bytes + bytes > 256 * 1024 ||
      this.pending.size >= 4096 ||
      this.socket.bufferedAmount > 256 * 1024
    ) {
      this.close();
      return Promise.reject(disconnected());
    }
    return new Promise((resolve, reject) => {
      this.bytes += bytes;
      this.pending.set(id, { resolve, reject, bytes, cancel: timer(10_000, () => this.close()) });
      try {
        this.socket.send(frame);
      } catch {
        this.close();
      }
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.cancelHandshake();
    this.cancelHeartbeat();
    this.socket.close();
    for (const pending of this.pending.values()) {
      pending.cancel();
      pending.reject(disconnected());
    }
    this.pending.clear();
    this.failed();
  }
}

/** Transport and metadata are keyed by environment as well as canonical terminal identity. */
export function createDirectTerminalTransport() {
  const connections = new Map<string, DirectTerminalConnection>();
  const summaries = new Map<string, Map<string, TerminalSummary>>();
  const listeners = new Map<string, Set<(event: TerminalMetadataStreamEvent) => void>>();
  const key = (environment: string, input: TerminalAttachInput) =>
    JSON.stringify([environment, input.threadId, input.terminalId]);
  const summaryKey = (input: { threadId: string; terminalId: string }) =>
    JSON.stringify([input.threadId, input.terminalId]);
  const remember = (environment: string, event: TerminalAttachStreamEvent) => {
    const entries = summaries.get(environment) ?? new Map<string, TerminalSummary>();
    summaries.set(environment, entries);
    let update: TerminalMetadataStreamEvent | undefined;
    if ("snapshot" in event) {
      const { history: _history, sequence: _sequence, ...snapshot } = event.snapshot;
      const terminal = { ...snapshot, hasRunningSubprocess: false };
      entries.set(summaryKey(terminal), terminal);
      update = { type: "upsert", terminal };
    } else if (event.type === "closed") {
      entries.delete(summaryKey(event));
      update = { type: "remove", threadId: event.threadId, terminalId: event.terminalId };
    } else if (event.type === "activity" || event.type === "exited" || event.type === "error") {
      const old = entries.get(summaryKey(event));
      if (old) {
        const terminal = {
          ...old,
          ...(event.type === "activity"
            ? { hasRunningSubprocess: event.hasRunningSubprocess, label: event.label }
            : {
                status: event.type === "exited" ? ("exited" as const) : ("error" as const),
                hasRunningSubprocess: false,
              }),
        };
        entries.set(summaryKey(event), terminal);
        update = { type: "upsert", terminal };
      }
    }
    if (update) for (const listener of listeners.get(environment) ?? []) listener(update);
  };
  const attach = (input: TerminalAttachInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const supervisor = yield* EnvironmentSupervisor;
        const environment = supervisor.target.environmentId;
        const relay = subscribe(WS_METHODS.terminalAttach, input);
        const config = yield* request(WS_METHODS.serverGetConfig, {}).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (!config?.environment.capabilities.directTerminals) return relay;
        const grant = yield* request(WS_METHODS.terminalConnection, input).pipe(
          Effect.timeout("8 seconds"),
          Effect.catch(() => Effect.succeed(null)),
        );
        if (!grant) return relay;
        const stream = Stream.callback<TerminalAttachStreamEvent, TerminalRemoteError>(
          (queue) =>
            Effect.gen(function* () {
              const id = key(environment, input);
              const connection = yield* Effect.try({
                try: () =>
                  new DirectTerminalConnection(
                    grant,
                    input,
                    (event) => {
                      remember(environment, event);
                      if (!Queue.offerUnsafe(queue, event)) connection.close();
                    },
                    () => {
                      if (connections.get(id) === connection) {
                        connections.delete(id);
                        summaries.get(environment)?.delete(summaryKey(input));
                      }
                      Queue.failCauseUnsafe(queue, Cause.fail(disconnected()));
                    },
                  ),
                catch: disconnected,
              });
              connections.set(id, connection);
              yield* Effect.addFinalizer(() => Effect.sync(() => connection.close()));
            }),
          { bufferSize: 256 },
        );
        // A fresh relay snapshot replaces the direct buffer; pending input is never resubmitted.
        return stream.pipe(Stream.catch(() => relay));
      }),
    );
  const command = (input: TerminalWriteInput | TerminalResizeInput) =>
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor;
      const connection = connections.get(key(supervisor.target.environmentId, input));
      if (connection?.isReady)
        return yield* Effect.tryPromise({
          try: () =>
            connection.command(
              "data" in input
                ? { type: "write", data: input.data }
                : { type: "resize", cols: input.cols, rows: input.rows },
            ),
          catch: disconnected,
        });
      if ("data" in input) return yield* request(WS_METHODS.terminalWrite, input);
      return yield* request(WS_METHODS.terminalResize, input);
    });
  const metadata = Stream.unwrap(
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor;
      const environment = supervisor.target.environmentId;
      const local = Stream.callback<TerminalMetadataStreamEvent>((queue) =>
        Effect.gen(function* () {
          const accept = (event: TerminalMetadataStreamEvent) => {
            Queue.offerUnsafe(queue, event);
          };
          const set = listeners.get(environment) ?? new Set();
          listeners.set(environment, set);
          set.add(accept);
          for (const terminal of summaries.get(environment)?.values() ?? [])
            accept({ type: "upsert", terminal });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              set.delete(accept);
            }),
          );
        }),
      );
      return Stream.merge(
        subscribe(WS_METHODS.subscribeTerminalMetadata, {}).pipe(
          Stream.map((event) => {
            if (event.type !== "snapshot") return event;
            const merged = new Map(event.terminals.map((t) => [summaryKey(t), t]));
            for (const [id, terminal] of summaries.get(environment) ?? []) merged.set(id, terminal);
            return { ...event, terminals: [...merged.values()] };
          }),
        ),
        local,
      );
    }),
  );
  return { attach, command, metadata };
}
