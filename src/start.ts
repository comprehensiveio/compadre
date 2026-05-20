import dotenv from "dotenv";
import { ensureRuntimeDependencies } from "./runtime.js";

dotenv.config({ path: ".env.local" });
ensureRuntimeDependencies();

await import("./index.js");
