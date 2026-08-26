import assert from "node:assert/strict";
import test from "node:test";
import { SandboxFilesystemNotFoundError, type Sandbox } from "modal";
import {
  cacheSuccessfulPromise,
  ModalHandle,
  MODAL_CAPS,
  modalImageCommands,
  modalResourceSettings,
  modalSandboxProvider,
  parseModalProcessTable,
} from "./modal-sandbox.js";

function sandboxStub(overrides: Record<string, unknown> = {}): Sandbox {
  return {
    sandboxId: "sb-test",
    filesystem: {},
    exec: async () => {
      throw new Error("unexpected exec");
    },
    terminate: async () => undefined,
    ...overrides,
  } as unknown as Sandbox;
}

test("advertises the Modal capabilities used by TanStack", () => {
  assert.deepEqual(MODAL_CAPS, {
    fs: true,
    exec: true,
    env: true,
    ports: false,
    backgroundProcesses: true,
    writableStdin: false,
    killableProcesses: false,
    snapshots: true,
    networkPolicy: false,
    durableFilesystem: false,
    fork: false,
  });
});

test("summarizes bounded Modal process telemetry without command arguments", () => {
  assert.deepEqual(
    parseModalProcessTable(
      "  32  29 585092 claude\n1259 1258 2740996 tsc\ninvalid arguments --secret\n",
    ),
    {
      processCount: 2,
      rssBytes: (585_092 + 2_740_996) * 1024,
      topProcess: "tsc",
      topProcessRssBytes: 2_740_996 * 1024,
    },
  );
});

test("samples a Modal harness before the first periodic interval", async () => {
  const commands: string[][] = [];
  let terminateCalls = 0;
  const stream = (text = "") => {
    const readable = new ReadableStream<string>({
      start(controller) {
        if (text) controller.enqueue(text);
        controller.close();
      },
    });
    return Object.assign(readable, { readText: async () => text });
  };
  const sandbox = sandboxStub({
    exec: async (command: string[]) => {
      commands.push(command);
      return {
        stdout: stream(command[0] === "ps" ? "32 29 1024 claude\n" : ""),
        stderr: stream(),
        stdin: { writeText: async () => undefined },
        closeStdin: async () => undefined,
        wait: async () => 0,
      };
    },
    terminate: async () => {
      terminateCalls += 1;
    },
  });
  const handle = new ModalHandle(sandbox);

  const spawned = await handle.process.spawn("claude");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(commands[0]?.[0], "bash");
  assert.deepEqual(commands[1], ["ps", "-eo", "pid=,ppid=,rss=,comm="]);
  assert.equal(await spawned.wait(), 0);
  await handle.destroy();
  assert.equal(terminateCalls, 1);
});

test("snapshots thread state before terminating billed compute", async () => {
  const events: string[] = [];
  const sandbox = sandboxStub({
    snapshotFilesystem: async (options?: { ttlMs?: number | null }) => {
      events.push(`snapshot:${options?.ttlMs}`);
      return { imageId: "im-thread-state" } as never;
    },
    terminate: async () => {
      events.push("terminate");
    },
  });
  const handle = new ModalHandle(sandbox, "/workspace", 123_000);

  assert.deepEqual(await handle.snapshot("after-run"), {
    id: "im-thread-state",
    label: "after-run",
  });
  assert.deepEqual(events, ["snapshot:123000", "terminate"]);
});

test("treats an absent Modal filesystem path as non-existent", async () => {
  const sandbox = sandboxStub({
    filesystem: {
      stat: async () => {
        throw new SandboxFilesystemNotFoundError("missing");
      },
    },
  });
  const handle = new ModalHandle(sandbox);

  assert.equal(await handle.fs.exists("/workspace/pnpm-lock.yaml"), false);
});

test("rejects malformed Modal resource settings before provisioning", () => {
  assert.throws(
    () =>
      modalSandboxProvider({
        environment: { COMPADRE_MODAL_MEMORY_MIB: "many" },
      }),
    /COMPADRE_MODAL_MEMORY_MIB must be a positive number/,
  );
});

test("keeps the 2 GiB request while allowing a 16 GiB memory burst", () => {
  const resources = modalResourceSettings({});
  assert.equal(resources.memoryMiB, 2048);
  assert.equal(resources.memoryLimitMiB, 16384);
});

test("bakes pinned harness CLIs into the default Modal image", () => {
  const commands = modalImageCommands({});
  assert.match(commands.join("\n"), /claude-code@2\.1\.222/);
  assert.match(commands.join("\n"), /codex@0\.146\.0/);
  assert.match(commands.join("\n"), /--prefix '\/opt\/compadre-runtime'/);
  assert.match(
    commands.join("\n"),
    /\/opt\/compadre-runtime\/node_modules\/\.bin\/claude' \/usr\/local\/bin\/claude/,
  );
  assert.match(
    commands.join("\n"),
    /\/opt\/compadre-runtime\/node_modules\/\.bin\/codex' \/usr\/local\/bin\/codex/,
  );
});

test("bakes the app repository's required command-line tools", () => {
  const commands = modalImageCommands({}).join("\n");
  for (const command of ["gh", "jq", "postgresql-client", "ripgrep"]) {
    assert.match(commands, new RegExp(`\\b${command}\\b`));
  }
  assert.match(commands, /corepack prepare pnpm@10\.34\.2 --activate/);
});

test("allows a custom Modal image to supply its own harness CLIs", () => {
  assert.doesNotMatch(
    modalImageCommands({ COMPADRE_MODAL_SKIP_CLI_SETUP: "true" }).join("\n"),
    /npm install/,
  );
});

test("retries cached Modal preparation after a transient failure", async () => {
  let attempts = 0;
  const prepare = cacheSuccessfulPromise(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("transient");
    return "ready";
  });

  await assert.rejects(prepare(), /transient/);
  assert.equal(await prepare(), "ready");
  assert.equal(await prepare(), "ready");
  assert.equal(attempts, 2);
});
