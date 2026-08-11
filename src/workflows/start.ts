import { initializeCompadreProcess } from "../process-bootstrap.js";

await initializeCompadreProcess({ ephemeral: true });
await import("./tasks.js");

console.log("[workflow-agent] tasks registered");
