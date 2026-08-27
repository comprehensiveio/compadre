import dotenv from "dotenv";
import { T3_GATEWAY_CREDENTIAL_PATH } from "../src/t3/modal-worker.js";
import type { T3ThreadBinding } from "../src/services/t3-thread-bindings.js";
import { modalSandboxProvider } from "../src/tanstack/modal-sandbox.js";
import { T3Client } from "../src/t3/client.js";
import { T3ModalEnvironmentManager } from "../src/t3/modal-environments.js";

dotenv.config({ path: ".env.local", quiet: true, override: true });

const [sandboxId, t3ThreadId] = process.argv.slice(2);
if (!sandboxId || !t3ThreadId) {
  throw new Error(
    "Usage: probe-t3-reconnect.ts <sandbox-id> <t3-thread-id>",
  );
}
const environment = {
  ...process.env,
  COMPADRE_MODAL_APP:
    process.env.COMPADRE_T3_MODAL_APP?.trim() || "compadre-t3-experiment",
};
const provider = modalSandboxProvider({ environment, encryptedPorts: [3773] });
const handle = await provider.resume({ id: sandboxId });
if (!handle) throw new Error(`Sandbox ${sandboxId} is unavailable`);
const accessToken = (await handle.fs.read(T3_GATEWAY_CREDENTIAL_PATH)).trim();
const channel = await handle.ports.connect(3773);
const discoveryClient = new T3Client(channel.url, accessToken);
const original = await discoveryClient.threadSnapshot(t3ThreadId);
const timestamp = new Date().toISOString();
const binding: T3ThreadBinding = {
  canonicalThreadId: "reconnect-probe",
  providerInstanceId: original.thread.modelSelection.instanceId,
  t3ThreadId,
  projectId: original.thread.projectId,
  sandboxId,
  baseUrl: channel.url,
  modelSelection: original.thread.modelSelection,
  createdAt: timestamp,
  updatedAt: timestamp,
};

// Reconnect through a fresh manager instance to model a Render process restart.
const manager = new T3ModalEnvironmentManager(process.env);
const connection = await manager.reconnect(binding);
const dispatch = await connection.client.startTurn({
  threadId: t3ThreadId,
  text: "Reply with RECONNECTED only.",
  modelSelection: binding.modelSelection,
});
console.error(
  `[t3-reconnect-probe] dispatched sequence=${dispatch.sequence} messageId=${dispatch.messageId} createdAt=${dispatch.createdAt}`,
);
const terminal = await connection.client.waitForTurnTerminal({
  threadId: t3ThreadId,
  minimumSequence: dispatch.sequence,
  messageId: dispatch.messageId,
  requestedAt: dispatch.createdAt,
  timeoutMs: 10 * 60_000,
});
const assistant = [...terminal.thread.messages]
  .reverse()
  .find(
    (message) =>
      message.role === "assistant" &&
      message.turnId === terminal.thread.latestTurn?.turnId,
  );
console.log(
  JSON.stringify(
    {
      sandboxId,
      t3ThreadId,
      sequence: dispatch.sequence,
      terminalState: terminal.thread.latestTurn?.state,
      assistantText: assistant?.text,
    },
    null,
    2,
  ),
);
