import assert from "node:assert/strict";
import test from "node:test";
import { SandboxFilesystemNotFoundError, type Sandbox } from "modal";
import { ModalHandle, MODAL_CAPS } from "./modal-sandbox.js";

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
