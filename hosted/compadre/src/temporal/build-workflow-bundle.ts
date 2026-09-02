/**
 * Build the Temporal workflow bundle at compile time so deployed workflow
 * code is frozen with the release artifact (dist/temporal-workflow-bundle.js)
 * instead of being re-bundled at worker startup.
 *
 * Invoked by `npm run build`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundleWorkflowCode } from "@temporalio/worker";

async function main() {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const bundle = await bundleWorkflowCode({
    workflowsPath: path.resolve(directory, "./workflows.ts"),
  });
  const outDir = path.resolve(directory, "../../dist");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.resolve(outDir, "temporal-workflow-bundle.js");
  fs.writeFileSync(outFile, bundle.code);
  console.log(`Workflow bundle written to ${outFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
