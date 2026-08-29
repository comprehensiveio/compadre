import { createHash } from "node:crypto";
import { extname } from "node:path";
import type { SandboxHandle } from "@tanstack/ai-sandbox";

export const T3_OUTPUT_ARTIFACT_DIR = "/tmp/agent-outputs";
const MARKER_DIR = "/tmp/compadre-output-markers";
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PER_TURN = 25;
const MAX_ENTRIES = 1_000;

export interface T3OutputArtifact {
  bytes: Uint8Array;
  digest: string;
  filename: string;
  mimetype: string;
  path: string;
  title: string;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function discover(handle: SandboxHandle) {
  if (!(await handle.fs.exists(T3_OUTPUT_ARTIFACT_DIR))) return [];
  const pending = [T3_OUTPUT_ARTIFACT_DIR];
  const files: Array<{ path: string; relativePath: string; filename: string }> = [];
  let seen = 0;
  while (pending.length > 0 && seen < MAX_ENTRIES) {
    const directory = pending.shift()!;
    for (const entry of await handle.fs.list(directory)) {
      seen += 1;
      if (seen > MAX_ENTRIES) break;
      if (entry.name.startsWith(".")) continue;
      if (entry.type === "dir") {
        pending.push(entry.path);
        continue;
      }
      const relativePath = entry.path.slice(`${T3_OUTPUT_ARTIFACT_DIR}/`.length);
      if (!relativePath || relativePath.startsWith("/") || relativePath.includes("../")) continue;
      files.push({ path: entry.path, relativePath, filename: entry.name });
    }
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function regularFileSize(handle: SandboxHandle, filePath: string) {
  const result = await handle.process.exec(
    `test -f ${quote(filePath)} && test ! -L ${quote(filePath)} && stat -c '%s %h' -- ${quote(filePath)}`,
  );
  if (result.exitCode !== 0) return undefined;
  const [sizeText, linksText] = result.stdout.trim().split(" ");
  const size = Number(sizeText);
  return Number.isSafeInteger(size) && size >= 0 && Number(linksText) === 1
    ? size
    : undefined;
}

function mimetype(bytes: Uint8Array, filename: string): string {
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const header = new TextDecoder("ascii").decode(bytes.subarray(0, 12));
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return "image/gif";
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") return "image/webp";
  if (header.startsWith("%PDF-")) return "application/pdf";
  return ({
    ".csv": "text/csv",
    ".json": "application/json",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".pdf": "application/pdf",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".zip": "application/zip",
  } as Record<string, string>)[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

function markerPath(path: string, digest: string): string {
  const marker = createHash("sha256").update(path).update("\0").update(digest).digest("hex");
  return `${MARKER_DIR}/${marker}`;
}

/** Collect safe regular files created by the agent and publish each at most once. */
export async function collectT3OutputArtifacts(
  handle: SandboxHandle,
  publish: (artifact: T3OutputArtifact) => Promise<void>,
): Promise<{ published: Array<{ path: string; digest: string }>; failures: string[] }> {
  const published: Array<{ path: string; digest: string }> = [];
  const failures: string[] = [];
  let attempted = 0;
  for (const file of await discover(handle)) {
    const size = await regularFileSize(handle, file.path);
    if (size === undefined) continue;
    if (size > MAX_BYTES) {
      failures.push(`${file.relativePath}: exceeds the ${MAX_BYTES}-byte limit`);
      continue;
    }
    const bytes = await handle.fs.readBytes(file.path);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const marker = markerPath(file.relativePath, digest);
    if (await handle.fs.exists(marker)) {
      published.push({ path: file.relativePath, digest });
      continue;
    }
    if (attempted >= MAX_PER_TURN) {
      failures.push(`${file.relativePath}: exceeds the ${MAX_PER_TURN}-file turn limit`);
      continue;
    }
    attempted += 1;
    try {
      await publish({
        bytes,
        digest,
        filename: file.filename,
        mimetype: mimetype(bytes, file.filename),
        path: file.relativePath,
        title: file.relativePath,
      });
      published.push({ path: file.relativePath, digest });
      try {
        await handle.fs.mkdir(MARKER_DIR);
        await handle.fs.write(marker, `${file.relativePath}\n${digest}\n`);
      } catch (error) {
        console.warn("[t3-artifacts] could not write publication marker", { path: file.relativePath, error });
      }
    } catch (error) {
      failures.push(`${file.relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { published, failures };
}

