import dotenv from "dotenv";
import { T3_GATEWAY_CREDENTIAL_PATH } from "../src/t3/modal-worker.js";
import { modalSandboxProvider } from "../src/tanstack/modal-sandbox.js";
import { T3Client } from "../src/t3/client.js";

dotenv.config({ path: ".env.local", quiet: true, override: true });
const [sandboxId, threadId] = process.argv.slice(2);
if (!sandboxId || !threadId) {
  throw new Error("Usage: inspect-t3-modal-thread.ts <sandbox-id> <thread-id>");
}
const environment = {
  ...process.env,
  COMPADRE_MODAL_APP:
    process.env.COMPADRE_T3_MODAL_APP?.trim() || "compadre-t3-experiment",
};
const provider = modalSandboxProvider({ environment, encryptedPorts: [3773] });
const handle = await provider.resume({ id: sandboxId });
if (!handle) throw new Error(`Sandbox ${sandboxId} is unavailable`);
const token = (await handle.fs.read(T3_GATEWAY_CREDENTIAL_PATH)).trim();
const channel = await handle.ports.connect(3773);
const snapshot = await new T3Client(channel.url, token).threadSnapshot(threadId);
console.log(
  JSON.stringify(
    {
      snapshotSequence: snapshot.snapshotSequence,
      latestTurn: snapshot.thread.latestTurn,
      session: snapshot.thread.session,
      messages: snapshot.thread.messages.slice(-8).map((message) => ({
        id: message.id,
        role: message.role,
        turnId: message.turnId,
        streaming: message.streaming,
        textLength: message.text.length,
        textPreview: message.text.slice(0, 120),
        createdAt: message.createdAt,
      })),
    },
    null,
    2,
  ),
);
