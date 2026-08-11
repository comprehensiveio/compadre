import dotenv from "dotenv";
import { prepareRepositorySeed } from "../src/repo.js";

dotenv.config({ path: ".env.local", quiet: true });

const startedAt = Date.now();
const seedPath = prepareRepositorySeed();
console.log(
  JSON.stringify({
    event: "workflow.repository-seeded",
    seedPath,
    elapsedMs: Date.now() - startedAt,
  }),
);
