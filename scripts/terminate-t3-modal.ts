import dotenv from "dotenv";
import { modalSandboxProvider } from "../src/tanstack/modal-sandbox.js";

dotenv.config({ path: ".env.local", quiet: true, override: true });
const sandboxIds = process.argv.slice(2);
if (sandboxIds.length === 0 || sandboxIds.some((id) => !/^sb-[A-Za-z0-9]+$/.test(id))) {
  throw new Error("Usage: terminate-t3-modal.ts <sandbox-id> [sandbox-id...]");
}
const environment = {
  ...process.env,
  COMPADRE_MODAL_APP:
    process.env.COMPADRE_T3_MODAL_APP?.trim() || "compadre",
};
const provider = modalSandboxProvider({ environment, encryptedPorts: [3773] });
for (const id of sandboxIds) {
  await provider.destroy({ id });
  console.log(`Terminated ${id}`);
}
