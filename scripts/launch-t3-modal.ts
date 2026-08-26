import dotenv from "dotenv";
import { launchT3ModalExperiment } from "../src/experiments/t3-modal.js";

dotenv.config({ path: ".env.local", quiet: true, override: true });

const result = await launchT3ModalExperiment();
console.log(JSON.stringify(result, null, 2));
