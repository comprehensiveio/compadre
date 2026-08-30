import path from "node:path";
import { z } from "zod";

export const MAX_INPUT_FILES = 8;
export const MAX_INPUT_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_INPUT_FILES_TOTAL_BYTES = 50 * 1024 * 1024;
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
    mimetype: z.string().trim().min(1).max(100).regex(/^[\w.+-]+\/[\w.+-]+$/u),
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

export const inputFilesSchema = z
  .array(inputFileSchema)
  .max(MAX_INPUT_FILES)
  .superRefine((files, context) => {
    const total = files.reduce((sum, file) => sum + file.sizeBytes, 0);
    if (total > MAX_INPUT_FILES_TOTAL_BYTES) {
      context.addIssue({
        code: "custom",
        message: "combined attachment size exceeds 50 MiB",
      });
    }
  });

export type InputFile = z.infer<typeof inputFileSchema>;

export interface MaterializedInputFiles {
  prompt: string;
  uploads: Array<{ path: string; data: Uint8Array }>;
}

function safeFilename(file: InputFile, index: number): string {
  const original = path.basename(file.name).replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  const extension = IMAGE_EXTENSIONS[file.mimetype];
  const basename = original || (extension ? `image${extension}` : "file.bin");
  const normalized = extension && !basename.endsWith(extension)
    ? `${basename}${extension}`
    : basename;
  return `${index + 1}-web-${normalized}`;
}

/** Materialize authenticated API/browser file bytes for upload into Modal. */
export function materializeInputFiles(
  files: readonly InputFile[],
  promptDirectory: string,
): MaterializedInputFiles {
  if (files.length === 0) return { prompt: "", uploads: [] };
  const lines = [
    "Attachments for this request:",
    "Inspect relevant paths with the appropriate file-reading tool before answering.",
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
