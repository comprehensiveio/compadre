import {
  TerminalAttachStreamEvent,
  TerminalSessionSnapshot,
  TerminalRemoteError,
  ThreadId,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type TerminalSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { CompadreTerminalInput, type TerminalInputSocket } from "./CompadreTerminalInput.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { TerminalManager } from "./Manager.ts";

const envelope = Schema.Struct({
  value: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.String),
});
const decodeEnvelope = Schema.decodeUnknownSync(Schema.fromJsonString(envelope));
const encodeBody = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeEvent = Schema.decodeUnknownSync(TerminalAttachStreamEvent);
const decodeSnapshot = Schema.decodeUnknownSync(TerminalSessionSnapshot);
const isRemoteError = Schema.is(TerminalRemoteError);
const remoteError = (error: unknown) =>
  new TerminalRemoteError({
    message: isRemoteError(error)
      ? error.message
      : "Terminal connection interrupted. Reopen the terminal to connect again.",
  });

/** Hosted terminals never fall back to a shell in the central server's filesystem. */
export function makeCompadreTerminal(
  projection: Pick<ProjectionSnapshotQueryShape, "getThreadCheckpointContext"> &
    Partial<Pick<ProjectionSnapshotQueryShape, "getThreadShellById">>,
  environment: NodeJS.ProcessEnv = process.env,
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
  createInputSocket?: (url: URL) => TerminalInputSocket,
): TerminalManager["Service"] | undefined {
  const origin = environment.COMPADRE_NATIVE_T3_URL?.trim();
  if (!origin) return undefined;
  const url = new URL("/hosted/t3/terminal", origin);
  const inputUrl = new URL("/hosted/t3/terminal/input", origin);
  inputUrl.protocol = inputUrl.protocol === "https:" ? "wss:" : "ws:";
  const inputConnections = new Map<string, Promise<CompadreTerminalInput>>();
  const inputConnection = async (target: {
    threadId: string;
    terminalId: string;
  }): Promise<CompadreTerminalInput> => {
    const key = `${target.threadId}:${target.terminalId}`;
    let pending = inputConnections.get(key);
    if (!pending) {
      pending = (async () => {
        const context = await Effect.runPromise(
          projection.getThreadCheckpointContext(ThreadId.make(target.threadId)),
        );
        if (Option.isNone(context))
          throw new TerminalRemoteError({ message: "Thread is unavailable." });
        return new CompadreTerminalInput(
          inputUrl,
          environment.COMPADRE_API_KEY ?? "",
          target,
          createInputSocket,
        );
      })();
      inputConnections.set(key, pending);
    }
    try {
      const connection = await pending;
      if (!connection.isClosed) return connection;
      if (inputConnections.get(key) === pending) inputConnections.delete(key);
      return inputConnection(target);
    } catch (error) {
      if (inputConnections.get(key) === pending) inputConnections.delete(key);
      throw error;
    }
  };
  const metadata = new Map<string, TerminalSummary>();
  const eventListeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
  const metadataListeners = new Set<(event: TerminalMetadataStreamEvent) => Effect.Effect<void>>();
  const publishMetadata = async (event: TerminalMetadataStreamEvent) => {
    for (const listener of metadataListeners) await Effect.runPromise(listener(event));
  };
  const remember = async (event: TerminalAttachStreamEvent) => {
    if ("snapshot" in event) {
      const { history: _history, sequence: _sequence, ...snapshot } = event.snapshot;
      const summary = { ...snapshot, hasRunningSubprocess: false };
      metadata.set(`${summary.threadId}:${summary.terminalId}`, summary);
      await publishMetadata({ type: "upsert", terminal: summary });
    } else if (event.type === "closed") {
      metadata.delete(`${event.threadId}:${event.terminalId}`);
      await publishMetadata({
        type: "remove",
        threadId: event.threadId,
        terminalId: event.terminalId,
      });
    } else if (event.type === "activity" || event.type === "exited" || event.type === "error") {
      const key = `${event.threadId}:${event.terminalId}`;
      const old = metadata.get(key);
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
        metadata.set(key, terminal);
        await publishMetadata({ type: "upsert", terminal });
      }
    }
    for (const listener of eventListeners) {
      await Effect.runPromise(
        listener(
          event.type === "snapshot"
            ? {
                type: "started",
                snapshot: event.snapshot,
                threadId: event.snapshot.threadId,
                terminalId: event.snapshot.terminalId,
              }
            : event,
        ),
      );
    }
  };
  async function* request(operation: string, input: { threadId: string }, signal: AbortSignal) {
    const context = await Effect.runPromise(
      projection.getThreadCheckpointContext(ThreadId.make(input.threadId)),
    );
    if (Option.isNone(context))
      throw new TerminalRemoteError({ message: "Thread is unavailable." });
    const shell =
      operation === "open" &&
      "startWorker" in input &&
      input.startWorker === true &&
      projection.getThreadShellById
        ? await Effect.runPromise(projection.getThreadShellById(ThreadId.make(input.threadId)))
        : Option.none();
    const workerInput = Option.isSome(shell)
      ? {
          ...input,
          creation: { title: shell.value.title, modelSelection: shell.value.modelSelection },
        }
      : input;
    const response = await fetcher(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${environment.COMPADRE_API_KEY ?? ""}`,
        "content-type": "application/json",
      },
      body: encodeBody({ operation, input: workerInput }),
      signal,
    });
    if (!response.ok || !response.body) {
      const decoded = decodeEnvelope(await response.text());
      throw new TerminalRemoteError({
        message: decoded.error ?? "Workspace terminal is unavailable.",
      });
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > 4 * 1024 * 1024) throw new Error("Terminal response exceeds limit");
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const message = decodeEnvelope(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (message.error) throw new TerminalRemoteError({ message: message.error });
          yield message.value;
        }
      }
      if (buffer.trim()) throw new Error("Incomplete terminal response");
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  const command = (operation: string, input: { threadId: string }) =>
    Effect.tryPromise({
      try: async (signal) => {
        let result: unknown;
        for await (const value of request(
          operation,
          input,
          AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
        ))
          result = value;
        return result;
      },
      catch: remoteError,
    });
  return {
    open: (input) =>
      command("open", input).pipe(
        Effect.flatMap((value) =>
          Effect.try({ try: () => decodeSnapshot(value), catch: remoteError }),
        ),
      ),
    restart: (input) =>
      command("restart", input).pipe(
        Effect.flatMap((value) =>
          Effect.try({ try: () => decodeSnapshot(value), catch: remoteError }),
        ),
      ),
    write: (input) =>
      Effect.tryPromise({
        try: async () => (await inputConnection(input)).write(input.data),
        catch: remoteError,
      }),
    resize: (input) => command("resize", input).pipe(Effect.asVoid),
    clear: (input) => command("clear", input).pipe(Effect.asVoid),
    close: (input) => command("close", input).pipe(Effect.asVoid),
    attachStream: (input, listener) =>
      Effect.sync(() => {
        const abort = new AbortController();
        void (async () => {
          try {
            for await (const value of request("attach", input, abort.signal)) {
              const event = decodeEvent(value);
              await remember(event);
              await Effect.runPromise(listener(event));
            }
            if (!abort.signal.aborted) throw new Error("Terminal stream ended");
          } catch (error) {
            if (abort.signal.aborted) return;
            const event = {
              type: "error" as const,
              threadId: input.threadId,
              terminalId: input.terminalId,
              message: remoteError(error).message,
            };
            await remember(event);
            await Effect.runPromise(listener(event));
          }
        })().catch(() => undefined);
        return () => abort.abort();
      }),
    subscribe: (listener) =>
      Effect.sync(() => {
        eventListeners.add(listener);
        return () => {
          eventListeners.delete(listener);
        };
      }),
    subscribeMetadata: (listener) =>
      Effect.gen(function* () {
        metadataListeners.add(listener);
        yield* listener({ type: "snapshot", terminals: [...metadata.values()] });
        return () => {
          metadataListeners.delete(listener);
        };
      }),
  };
}
