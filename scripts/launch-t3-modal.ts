import dotenv from "dotenv";
import { launchT3ModalWorker } from "../src/t3/modal-worker.js";

dotenv.config({ path: ".env.local", quiet: true, override: true });

const result = await launchT3ModalWorker();
console.log(JSON.stringify(result, null, 2));
