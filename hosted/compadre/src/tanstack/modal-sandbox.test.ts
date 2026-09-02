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
  modalSandboxTags,
  modalSecretNames,
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
  assert.match(commands.join("\n"), /t3@0\.0\.33/);
  assert.match(commands.join("\n"), /--prefix '\/opt\/compadre-runtime'/);
  assert.match(
    commands.join("\n"),
    /\/opt\/compadre-runtime\/node_modules\/\.bin\/claude' \/usr\/local\/bin\/claude/,
  );
  assert.match(
    commands.join("\n"),
    /\/opt\/compadre-runtime\/node_modules\/\.bin\/codex' \/usr\/local\/bin\/codex/,
  );
  assert.match(
    commands.join("\n"),
    /\/opt\/compadre-runtime\/node_modules\/\.bin\/t3' \/usr\/local\/bin\/t3/,
  );
});

test("exposes only explicitly configured Modal tunnels", async () => {
  const handle = new ModalHandle(
    sandboxStub({
      tunnels: async () => ({ 3773: { url: "https://t3.modal.run" } }),
    }),
    "/workspace",
    123_000,
    [3773],
  );

  assert.equal(handle.capabilities.ports, true);
  assert.deepEqual(await handle.ports.connect(3773), {
    url: "https://t3.modal.run",
  });
  await assert.rejects(handle.ports.connect(3000), /port 3000/);
});

test("advertises ports only for tunnel-enabled Modal providers", () => {
  const environment = {
    MODAL_TOKEN_ID: "test-id",
    MODAL_TOKEN_SECRET: "test-secret",
  };
  assert.equal(modalSandboxProvider({ environment }).capabilities().ports, false);
  assert.equal(
    modalSandboxProvider({ environment, encryptedPorts: [3773] }).capabilities()
      .ports,
    true,
  );
  assert.throws(
    () => modalSandboxProvider({ environment, encryptedPorts: [70_000] }),
    /1 to 65535/,
  );
});

test("normalizes named Modal secrets without exposing their values", () => {
  assert.deepEqual(
    modalSecretNames({
      COMPADRE_MODAL_SECRET_NAMES:
        "compadre-t3-auth, shared-tools,compadre-t3-auth, ,",
    }),
    ["compadre-t3-auth", "shared-tools"],
  );
  assert.deepEqual(modalSecretNames({}), []);
});

test("tags Modal workers for cost attribution without exposing thread ids", () => {
  const tags = modalSandboxTags({
    DD_ENV: "production",
    COMPADRE_CANONICAL_THREAD_ID: "slack:T01:C01:123.456",
    COMPADRE_PROVIDER_INSTANCE_ID: "codex",
    COMPADRE_WORKER_GENERATION: "4",
    COMPADRE_DEV_ENVIRONMENT_ENABLED: "true",
  });

  assert.deepEqual(tags, {
    managedBy: "compadre",
    environment: "production",
    purpose: "t3-worker",
    provider: "codex",
    devEnvironment: "true",
    workerGeneration: "4",
    threadKey: "b4f3971a8efaca24",
  });
  assert.doesNotMatch(JSON.stringify(tags), /slack:T01/);
});

test("bakes the app repository's required command-line tools", () => {
  const commands = modalImageCommands({}).join("\n");
  for (const command of ["gh", "jq", "postgresql-client", "ripgrep"]) {
    assert.match(commands, new RegExp(`\\b${command}\\b`));
  }
  assert.match(commands, /corepack prepare pnpm@10\.34\.2 --activate/);
});

test("adds stopped development services only when thread dev environments are enabled", () => {
  const ordinary = modalImageCommands({}).join("\n");
  const development = modalImageCommands({
    COMPADRE_DEV_ENVIRONMENT_ENABLED: "true",
  }).join("\n");

  assert.doesNotMatch(ordinary, /agent-browser@/);
  assert.doesNotMatch(ordinary, /postgresql-16/);
  assert.match(development, /agent-browser@0\.35\.1/);
  assert.match(development, /postgresql-16/);
  assert.match(development, /redis-server/);
  assert.doesNotMatch(development, /sudo/);
  assert.match(development, /AGENT_BROWSER_EXECUTABLE_PATH=\/usr\/bin\/chromium/);
  assert.match(development, /port = 5433/);
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
