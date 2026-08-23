import assert from "node:assert/strict";
import test from "node:test";
import { SandboxFilesystemNotFoundError, type Sandbox } from "modal";
import {
  cacheSuccessfulPromise,
  ModalHandle,
  MODAL_CAPS,
  modalImageCommands,
  modalSandboxProvider,
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

test("bakes pinned harness CLIs into the default Modal image", () => {
  const commands = modalImageCommands({});
  assert.match(commands.join("\n"), /claude-code@2\.1\.222/);
  assert.match(commands.join("\n"), /codex@0\.146\.0/);
  assert.match(commands.join("\n"), /--prefix '\/opt\/compadre-runtime'/);
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
