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
    return `@anthropic-ai/claude-agent-sdk-darwin-${architecture}`;
  }
  if (process.platform === "linux") {
    return `@anthropic-ai/claude-agent-sdk-linux-${architecture}${
      usesMusl() ? "-musl" : ""
    }`;
  }
  if (process.platform === "win32") {
    return `@anthropic-ai/claude-agent-sdk-win32-${architecture}`;
  }
  return undefined;
}

/**
 * Reuse the native Claude Code binary already shipped by the Agent SDK. This
 * avoids adding another 250+ MB CLI distribution solely for the TanStack path.
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
