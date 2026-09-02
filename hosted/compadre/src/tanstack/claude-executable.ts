import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function usesMusl(): boolean {
  if (process.platform !== "linux") return false;
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  const header = report?.header;
  return !header?.glibcVersionRuntime;
}

function bundledPackageName(): string | undefined {
  const architecture = process.arch === "x64" || process.arch === "arm64"
    ? process.arch
    : undefined;
  if (!architecture) return undefined;

  if (process.platform === "darwin") {
    return `@anthropic-ai/claude-code-darwin-${architecture}`;
  }
  if (process.platform === "linux") {
    return `@anthropic-ai/claude-code-linux-${architecture}${
      usesMusl() ? "-musl" : ""
    }`;
  }
  if (process.platform === "win32") {
    return `@anthropic-ai/claude-code-win32-${architecture}`;
  }
  return undefined;
}

/**
 * Resolve the native binary shipped by the official Claude Code package.
 */
export function resolveClaudeExecutable(): string {
  if (process.env.CLAUDE_CODE_EXECUTABLE) {
    return process.env.CLAUDE_CODE_EXECUTABLE;
  }
  if (process.env.COMPADRE_MODAL_SKIP_CLI_SETUP === "true") return "claude";
  const runtimeRoot =
    process.env.COMPADRE_MODAL_CLI_ROOT?.trim() || "/opt/compadre-runtime";
  return `${runtimeRoot}/node_modules/.bin/claude`;
}
