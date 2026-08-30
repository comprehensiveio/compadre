import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AnyServerTool } from "@tanstack/ai";

const MAX_SLACK_UPLOAD_BYTES = 20 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Materialize sandbox-local files for path-taking tools that execute on Render. */
export function withSandboxFileToolCompatibility(
  tools: ReadonlyArray<AnyServerTool>,
  readSandboxFile: (filePath: string) => Promise<Uint8Array>,
): AnyServerTool[] {
  return tools.map((tool) => {
    if (tool.name !== "slack_upload_file" || !tool.execute) return tool;
    const execute = tool.execute;
    return {
      ...tool,
      async execute(args: unknown, context?: unknown) {
        if (!isRecord(args) || typeof args.file_path !== "string") {
          return execute(args, context);
        }
        const sandboxPath = args.file_path;
        if (!path.posix.isAbsolute(sandboxPath)) {
          throw new Error("slack_upload_file requires an absolute sandbox path");
        }
        const bytes = await readSandboxFile(sandboxPath);
        if (bytes.byteLength > MAX_SLACK_UPLOAD_BYTES) {
          throw new Error(
            `Slack upload is too large (${bytes.byteLength} bytes; maximum ${MAX_SLACK_UPLOAD_BYTES})`,
          );
        }
        const directory = await fs.mkdtemp(
          path.join(os.tmpdir(), "compadre-slack-upload-"),
        );
        const hostPath = path.join(
          directory,
          path.posix.basename(sandboxPath) || "attachment",
        );
        try {
          await fs.writeFile(hostPath, bytes, { mode: 0o600 });
          return await execute({ ...args, file_path: hostPath }, context);
        } finally {
          await fs.rm(directory, { recursive: true, force: true });
        }
      },
    };
  });
}
