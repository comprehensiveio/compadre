import { initializeCompadreProcess } from "./process-bootstrap.js";

await initializeCompadreProcess();
await import("./index.js");
