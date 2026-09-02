import { createHash } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const MAX_BACKUP_BYTES = 100 * 1024 * 1024;
export const DEFAULT_CENTRAL_T3_BACKUP_INTERVAL_MS = 6 * 60 * 60_000;

export interface CentralT3BackupObjectStore {
  put(input: {
    key: string;
    bytes: Uint8Array;
    contentType: string;
    sha256: string;
  }): Promise<void>;
}

export class S3CentralT3BackupObjectStore
  implements CentralT3BackupObjectStore
{
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    options: { region: string; client?: S3Client },
  ) {
    this.client = options.client ?? new S3Client({ region: options.region });
  }

  async put(input: {
    key: string;
    bytes: Uint8Array;
    contentType: string;
    sha256: string;
  }): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.bytes,
        ContentLength: input.bytes.byteLength,
        ContentType: input.contentType,
        Metadata: { sha256: input.sha256 },
        ServerSideEncryption: "AES256",
      }),
    );
  }
}

function objectKey(now: Date, sha256: string): string {
  const timestamp = now.toISOString().replaceAll(/[:.]/gu, "-");
  const [year, month, day] = now.toISOString().slice(0, 10).split("-");
  return `backups/t3-state/v1/${year}/${month}/${day}/${timestamp}-${sha256}.sqlite`;
}

export async function backupCentralT3State(input: {
  centralUrl: string;
  accessToken: string;
  objects: CentralT3BackupObjectStore;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<{ key: string; sha256: string; sizeBytes: number }> {
  const endpoint = new URL(
    "/internal/compadre/state-backup",
    input.centralUrl,
  );
  const response = await (input.fetchImpl ?? fetch)(endpoint, {
    headers: { Authorization: `Bearer ${input.accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Central T3 backup endpoint returned HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_BACKUP_BYTES) {
    throw new Error("Central T3 backup exceeds the 100 MiB safety limit");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BACKUP_BYTES) {
    throw new Error("Central T3 backup has an invalid size");
  }
  if (declared > 0 && declared !== bytes.byteLength) {
    throw new Error("Central T3 backup Content-Length does not match its body");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const expected = response.headers.get("x-compadre-sha256")?.trim();
  if (!expected || expected !== sha256) {
    throw new Error("Central T3 backup failed SHA-256 verification");
  }
  const key = objectKey(input.now?.() ?? new Date(), sha256);
  await input.objects.put({
    key,
    bytes,
    contentType: "application/vnd.sqlite3",
    sha256,
  });
  return { key, sha256, sizeBytes: bytes.byteLength };
}

export function configuredCentralT3Backup(
  environment: NodeJS.ProcessEnv = process.env,
): (() => Promise<{ key: string; sha256: string; sizeBytes: number }>) | null {
  const centralUrl =
    environment.COMPADRE_T3_CENTRAL_URL?.trim() ||
    environment.COMPADRE_T3_HOSTED_APP_URL?.trim();
  const accessToken = environment.COMPADRE_BACKUP_TOKEN?.trim();
  const bucket = environment.COMPADRE_T3_ARTIFACT_BUCKET?.trim();
  const region =
    environment.COMPADRE_T3_ARTIFACT_REGION?.trim() ||
    environment.AWS_REGION?.trim() ||
    "us-east-1";
  if (!centralUrl || !accessToken || !bucket) return null;
  const objects = new S3CentralT3BackupObjectStore(bucket, { region });
  return () => backupCentralT3State({ centralUrl, accessToken, objects });
}
