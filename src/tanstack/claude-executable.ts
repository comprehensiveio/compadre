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

  const packageName = bundledPackageName();
  if (packageName) {
    try {
      const filename = process.platform === "win32" ? "claude.exe" : "claude";
      return require.resolve(`${packageName}/${filename}`);
    } catch {
      // Optional native packages may be omitted in slim installs. Let PATH be
      // the final fallback so a separately installed Claude CLI still works.
    }
  }

  return "claude";
}
