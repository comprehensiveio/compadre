import path from "node:path";
import { z } from "zod";

export const MAX_INPUT_FILES = 8;
export const MAX_INPUT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_INPUT_FILE_BYTES / 3) * 4;

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

export const inputFileSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    mimetype: z.enum(["image/gif", "image/jpeg", "image/png", "image/webp"]),
    sizeBytes: z.number().int().nonnegative().max(MAX_INPUT_FILE_BYTES),
    dataBase64: z.string().min(1).max(MAX_BASE64_CHARS),
  })
  .superRefine((file, context) => {
    if (
      file.dataBase64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(file.dataBase64)
    ) {
      context.addIssue({ code: "custom", message: "dataBase64 is not valid base64" });
      return;
    }
    const decoded = Buffer.from(file.dataBase64, "base64");
    if (decoded.toString("base64") !== file.dataBase64) {
      context.addIssue({ code: "custom", message: "dataBase64 is not canonical base64" });
      return;
    }
    if (decoded.byteLength !== file.sizeBytes) {
      context.addIssue({
        code: "custom",
        message: "sizeBytes does not match the decoded attachment size",
      });
    }
  });

export const inputFilesSchema = z.array(inputFileSchema).max(MAX_INPUT_FILES);

export type InputFile = z.infer<typeof inputFileSchema>;

export interface MaterializedInputFiles {
  prompt: string;
  uploads: Array<{ path: string; data: Uint8Array }>;
}

function safeFilename(file: InputFile, index: number): string {
  const original = path.basename(file.name).replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  const extension = IMAGE_EXTENSIONS[file.mimetype];
  const basename = original || `image${extension}`;
  return `${index + 1}-web-${basename.endsWith(extension) ? basename : `${basename}${extension}`}`;
}

/** Materialize authenticated API/browser image bytes for upload into Modal. */
export function materializeInputFiles(
  files: readonly InputFile[],
  promptDirectory: string,
): MaterializedInputFiles {
  if (files.length === 0) return { prompt: "", uploads: [] };
  const lines = [
    "Attachments for this request:",
    "Inspect relevant image paths with your native image-reading tool before answering.",
  ];
  const uploads = files.map((file, index) => {
    const destination = path.posix.join(promptDirectory, safeFilename(file, index));
    lines.push(
      `- ${JSON.stringify(file.name)} is available at ${JSON.stringify(destination)} (${file.mimetype}).`,
    );
    return {
      path: destination,
      data: Uint8Array.from(Buffer.from(file.dataBase64, "base64")),
    };
  });
  return { prompt: lines.join("\n"), uploads };
}
