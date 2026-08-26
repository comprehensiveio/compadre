import dotenv from "dotenv";
import { modalSandboxProvider } from "../src/tanstack/modal-sandbox.js";

dotenv.config({ path: ".env.local", quiet: true, override: true });

const sandboxId = process.argv[2];
if (!sandboxId) throw new Error("Usage: read-t3-modal-log.ts <sandbox-id>");
const environment = {
  ...process.env,
  COMPADRE_MODAL_APP:
    process.env.COMPADRE_T3_MODAL_APP?.trim() || "compadre-t3-experiment",
};
const provider = modalSandboxProvider({ environment, encryptedPorts: [3773] });
const handle = await provider.resume({ id: sandboxId });
if (!handle) throw new Error(`Sandbox ${sandboxId} is unavailable`);
const log = await handle.fs.read("/var/log/compadre/t3.log");
console.log(
  log
    .replace(/^Token:\s+\S+\s*$/gm, "Token: [redacted]")
    .replace(/(#token=)[^\s]+/g, "$1[redacted]")
    .slice(-10_000),
);
