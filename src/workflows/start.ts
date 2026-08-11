import { initializeCompadreProcess } from "../process-bootstrap.js";

await initializeCompadreProcess();
await import("./tasks.js");

console.log("[workflow-agent] tasks registered");
