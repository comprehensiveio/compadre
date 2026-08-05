import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "../..");

/** Resolve the reproducible project-local CLI, with an explicit deploy override. */
export function resolveCodexExecutable(): string {
  return (
    process.env.CODEX_EXECUTABLE ??
    path.join(PACKAGE_ROOT, "node_modules", ".bin", "codex")
  );
}
