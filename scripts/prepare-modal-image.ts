import dotenv from "dotenv";
import { prepareModalBaseImage } from "../src/tanstack/modal-sandbox.js";

dotenv.config({ path: ".env.local", quiet: true });

const startedAt = Date.now();
const image = await prepareModalBaseImage();
console.log(
  JSON.stringify({
    imageId: image.imageId,
    elapsedMs: Date.now() - startedAt,
  }),
);
