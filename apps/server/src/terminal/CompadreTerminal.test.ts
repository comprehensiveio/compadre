import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ProjectId, ThreadId, type TerminalAttachStreamEvent } from "@t3tools/contracts";
import { makeCompadreTerminal } from "./CompadreTerminal.ts";

const projection = {
  getThreadCheckpointContext: () =>
    Effect.succeed(
      Option.some({
        threadId: ThreadId.make("canonical"),
        projectId: ProjectId.make("project"),
        workspaceRoot: "/central-not-worker",
        worktreePath: null,
        checkpoints: [],
      }),
    ),
};
const env = { COMPADRE_NATIVE_T3_URL: "https://controller.example", COMPADRE_API_KEY: "secret" };
const snapshot = {
  threadId: "canonical",
  terminalId: "term-1",
  cwd: "/worker",
  worktreePath: null,
  status: "running",
  pid: 42,
  history: "worker λ$ ",
  exitCode: null,
  exitSignal: null,
  label: "zsh",
  updatedAt: "2026-09-05T12:00:00Z",
};

it.effect(
  "metadata subscriptions do not contact workers; a stopped attach reports an explicit-action prompt",
  () =>
    Effect.gen(function* () {
      const requests: unknown[] = [];
      const service = makeCompadreTerminal(projection, env, async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return Response.json(
          { error: "Workspace is stopped. Select Start terminal to start it." },
          { status: 409 },
        );
      })!;
      const unsubscribeMetadata = yield* service.subscribeMetadata(() => Effect.void);
      const unsubscribeEvents = yield* service.subscribe(() => Effect.void);
      expect(requests).toHaveLength(0);
      let receive!: (event: TerminalAttachStreamEvent) => void;
      const received = new Promise<TerminalAttachStreamEvent>((resolve) => {
        receive = resolve;
      });
      const detach = yield* service.attachStream(
        { threadId: "canonical", terminalId: "term-1" },
        (event) => Effect.sync(() => receive(event)),
      );
      expect(yield* Effect.promise(() => received)).toMatchObject({
        type: "error",
        message: expect.stringContaining("Start terminal"),
      });
      expect(requests).toEqual([
        { operation: "attach", input: { threadId: "canonical", terminalId: "term-1" } },
      ]);
      detach();
      unsubscribeEvents();
      unsubscribeMetadata();
    }),
);

it.effect(
  "relays worker history across fragmented UTF-8 and aborts only the attachment on disconnect",
  () =>
    Effect.gen(function* () {
      let cancelled!: () => void;
      const disconnected = new Promise<void>((resolve) => {
        cancelled = resolve;
      });
      const service = makeCompadreTerminal(projection, env, async (_url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
        const bytes = new TextEncoder().encode(
          JSON.stringify({ value: { type: "snapshot", snapshot } }) + "\n",
        );
        return new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
              init?.signal?.addEventListener(
                "abort",
                () => {
                  controller.close();
                  cancelled();
                },
                { once: true },
              );
            },
            cancel() {
              cancelled();
            },
          }),
        );
      })!;
      let receive!: (event: TerminalAttachStreamEvent) => void;
      const received = new Promise<TerminalAttachStreamEvent>((resolve) => {
        receive = resolve;
      });
      const detach = yield* service.attachStream(
        { threadId: "canonical", terminalId: "term-1" },
        (event) => Effect.sync(() => receive(event)),
      );
      expect(yield* Effect.promise(() => received)).toEqual({ type: "snapshot", snapshot });
      detach();
      // Abort closes the mocked HTTP body; the terminal close RPC is never used.
      yield* Effect.promise(() => disconnected);
    }),
);

it.effect("forwards startup intent only on explicit open and rejects unknown central threads", () =>
  Effect.gen(function* () {
    let calls = 0;
    const fetcher: NonNullable<Parameters<typeof makeCompadreTerminal>[2]> = async (_url, init) => {
      calls++;
      expect(JSON.parse(String(init?.body))).toMatchObject({
        operation: "open",
        input: { startWorker: true },
      });
      return new Response(JSON.stringify({ value: snapshot }) + "\n");
    };
    const service = makeCompadreTerminal(projection, env, fetcher)!;
    expect(
      (yield* service.open({
        threadId: "canonical",
        terminalId: "term-1",
        cwd: "/ignored",
        startWorker: true,
      })).cwd,
    ).toBe("/worker");
    const absent = makeCompadreTerminal(
      { getThreadCheckpointContext: () => Effect.succeed(Option.none()) },
      env,
      fetcher,
    )!;
    const error = yield* absent
      .open({ threadId: "missing", terminalId: "term-1", cwd: "/ignored", startWorker: true })
      .pipe(Effect.flip);
    expect(error.message).toBe("Thread is unavailable.");
    expect(calls).toBe(1);
    expect(makeCompadreTerminal(projection, {})).toBeUndefined();
  }),
);

it.effect("serializes input to one terminal across separate HTTP requests", () =>
  Effect.gen(function* () {
    const writes: string[] = [];
    let release!: () => void;
    const firstFinished = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const service = makeCompadreTerminal(projection, env, async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      writes.push(body.input.data);
      if (body.input.data === "a") {
        started();
        await firstFinished;
      }
      return new Response("");
    })!;
    const a = yield* service
      .write({ threadId: "canonical", terminalId: "term-1", data: "a" })
      .pipe(Effect.forkChild);
    const b = yield* service
      .write({ threadId: "canonical", terminalId: "term-1", data: "b" })
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => firstStarted);
    expect(writes).toEqual(["a"]);
    release();
    yield* Fiber.join(a);
    yield* Fiber.join(b);
    expect(writes).toEqual(["a", "b"]);
  }),
);
