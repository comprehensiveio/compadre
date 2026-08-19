import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { SlackClient, type DownloadedSlackFile } from "./slack-client.js";

export const MAX_SLACK_INPUT_FILES = 5;
export const MAX_SLACK_INPUT_FILE_BYTES = 10 * 1024 * 1024;

export const slackFileReferenceSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().optional(),
  mimetype: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
});

export type SlackFileReference = z.infer<typeof slackFileReferenceSchema>;

export interface SlackEventFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
}

interface SlackFileDownloader {
  downloadFile(
    fileId: string,
    maxBytes?: number,
  ): Promise<DownloadedSlackFile>;
}

export interface MaterializedSlackFiles {
  prompt: string;
  cleanup(): Promise<void>;
}

export function slackFileReferences(
  files: readonly SlackEventFile[] | undefined,
): SlackFileReference[] {
  if (!files) return [];
  return files.flatMap((file) => {
    if (!file.id) return [];
    return [{
      id: file.id,
      ...(file.name || file.title ? { name: file.name || file.title } : {}),
      ...(file.mimetype ? { mimetype: file.mimetype } : {}),
      ...(typeof file.size === "number" ? { size: file.size } : {}),
    }];
  });
}

export function mergeSlackFileReferences(
  ...groups: ReadonlyArray<readonly SlackFileReference[] | undefined>
): SlackFileReference[] {
  const byId = new Map<string, SlackFileReference>();
  for (const group of groups) {
    for (const file of group ?? []) {
      if (!byId.has(file.id)) byId.set(file.id, file);
    }
  }
  return [...byId.values()].slice(0, MAX_SLACK_INPUT_FILES);
}

function safeFilename(name: string, index: number): string {
  const basename = path.basename(name).replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  return `${index + 1}-${basename || "slack-image"}`;
}

function fileLabel(file: SlackFileReference): string {
  return file.name ? `${file.id} (${JSON.stringify(file.name)})` : file.id;
}

/**
 * Download Slack images to private temporary paths that coding harnesses can
 * inspect with their native image-reading tools. Failures stay in prompt
 * context instead of aborting an otherwise useful agent run.
 */
export async function materializeSlackFiles(
  files: readonly SlackFileReference[],
  options: {
    downloader?: SlackFileDownloader;
    environment?: NodeJS.ProcessEnv;
    directoryPrefix?: string;
  } = {},
): Promise<MaterializedSlackFiles> {
  const references = mergeSlackFileReferences(files);
  if (references.length === 0) {
    return { prompt: "", cleanup: async () => undefined };
  }

  const environment = options.environment ?? process.env;
  let downloader = options.downloader;
  if (!downloader) {
    const botToken = environment.SLACK_BOT_TOKEN;
    const teamId = environment.SLACK_TEAM_ID;
    if (botToken && teamId) {
      downloader = new SlackClient({ botToken, teamId });
    }
  }

  const lines = [
    "Slack attachments for this request:",
    "Inspect relevant image paths with your native image-reading tool before answering.",
  ];
  if (!downloader) {
    for (const file of references) {
      lines.push(`- ${fileLabel(file)} could not be downloaded because Slack credentials are unavailable.`);
    }
    return { prompt: lines.join("\n"), cleanup: async () => undefined };
  }

  let directory: string | undefined;
  for (const [index, file] of references.entries()) {
    try {
      const downloaded = await downloader.downloadFile(
        file.id,
        MAX_SLACK_INPUT_FILE_BYTES,
      );
      directory ??= await fs.mkdtemp(
        options.directoryPrefix ??
          path.join(os.tmpdir(), "compadre-slack-files-"),
      );
      const destination = path.join(
        directory,
        safeFilename(downloaded.name, index),
      );
      await fs.writeFile(destination, downloaded.data, { mode: 0o600 });
      lines.push(
        `- ${fileLabel(file)} is available at ${JSON.stringify(destination)} (${downloaded.mimetype}).`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[slack-files] failed to materialize ${file.id}: ${message}`);
      lines.push(`- ${fileLabel(file)} could not be downloaded: ${message}`);
    }
  }

  return {
    prompt: lines.join("\n"),
    cleanup: async () => {
      if (!directory) return;
      try {
        await fs.rm(directory, { recursive: true, force: true });
      } catch (error) {
        console.warn("[slack-files] failed to clean up temporary images", error);
      }
    },
  };
}
