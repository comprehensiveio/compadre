import dotenv from "dotenv";
import { memoryPersistence } from "@tanstack/ai-persistence";
import { T3ThreadBindingStore } from "../src/services/t3-thread-bindings.js";
import { T3Gateway } from "../src/t3/gateway.js";
import { T3ModalEnvironmentManager } from "../src/t3/modal-environments.js";

dotenv.config({ path: ".env.local", quiet: true, override: true });

let pairingUrl: string | undefined;
const manager = new T3ModalEnvironmentManager(process.env, (environment) => {
  pairingUrl = environment.pairingUrl;
});
const persistence = memoryPersistence();
const gateway = new T3Gateway(
  new T3ThreadBindingStore(persistence.stores.metadata),
  manager,
);

const turn = await gateway.send({
  canonicalThreadId: `gateway-probe-${Date.now()}`,
  title: "Compadre T3 gateway probe",
  text: "Reply with the repository owner and repository name only.",
  modelSelection: {
    instanceId: process.env.COMPADRE_T3_PROBE_PROVIDER?.trim() || "codex",
    model: process.env.COMPADRE_T3_PROBE_MODEL?.trim() || "gpt-5.6-sol",
  },
});
const terminal = await gateway.waitForTerminal({
  turn,
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
      sandboxId: turn.binding.sandboxId,
      baseUrl: turn.binding.baseUrl,
      pairingUrl,
      t3ThreadId: turn.binding.t3ThreadId,
      sequence: turn.dispatch.sequence,
      terminalState: terminal.thread.latestTurn?.state,
      assistantText: assistant?.text,
    },
    null,
    2,
  ),
);
