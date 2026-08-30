import crypto from "node:crypto";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type ListObjectsV2CommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { devEnvironmentEnabled } from "./dev-environment.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_AUDIENCE = "compadre-dev-backup";
const DEFAULT_BUCKET = "comp-prod-db-backups";
const DEFAULT_PREFIX = "hourly/";
const DEFAULT_REGION = "us-west-2";
const DEFAULT_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_DOWNLOAD_TTL_SECONDS = 6 * 60 * 60;

interface DevBackupTokenPayload {
  aud: typeof TOKEN_AUDIENCE;
  exp: number;
  threadId: string;
}

export interface LatestDevBackup {
  bucket: string;
  key: string;
  lastModified: string;
  sizeBytes: number;
  downloadUrl: string;
  expiresAt: string;
}

export function devProductionDataEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    devEnvironmentEnabled(environment) &&
    environment.COMPADRE_DEV_PRODUCTION_DATA_ENABLED?.trim() === "true"
  );
}

function integerSetting(
  name: string,
  raw: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const value = raw?.trim() ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < 60 || value > maximum) {
    throw new Error(`${name} must be an integer from 60 to ${maximum}`);
  }
  return value;
}

function tokenSignature(payload: string, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${TOKEN_AUDIENCE}:${payload}`)
    .digest("base64url");
}

export function issueDevBackupAccessToken(input: {
  canonicalThreadId: string;
  secret: string;
  expiresAtSeconds: number;
}): string {
  if (!UUID_PATTERN.test(input.canonicalThreadId)) {
    throw new Error("A canonical thread UUID is required for backup access");
  }
  if (!input.secret.trim())
    throw new Error("A backup access secret is required");
  const payload = Buffer.from(
    JSON.stringify({
      aud: TOKEN_AUDIENCE,
      exp: input.expiresAtSeconds,
      threadId: input.canonicalThreadId.toLowerCase(),
    } satisfies DevBackupTokenPayload),
  ).toString("base64url");
  return `${payload}.${tokenSignature(payload, input.secret)}`;
}

export function verifyDevBackupAccessToken(input: {
  token: string;
  canonicalThreadId: string;
  secret: string;
  nowSeconds?: number;
}): boolean {
  const [payload, suppliedSignature, extra] = input.token.split(".");
  if (!payload || !suppliedSignature || extra) return false;
  const expectedSignature = tokenSignature(payload, input.secret);
  const suppliedHash = crypto
    .createHash("sha256")
    .update(suppliedSignature)
    .digest();
  const expectedHash = crypto
    .createHash("sha256")
    .update(expectedSignature)
    .digest();
  if (!crypto.timingSafeEqual(suppliedHash, expectedHash)) return false;
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Partial<DevBackupTokenPayload>;
    return (
      decoded.aud === TOKEN_AUDIENCE &&
      decoded.threadId === input.canonicalThreadId.toLowerCase() &&
      typeof decoded.exp === "number" &&
      decoded.exp > (input.nowSeconds ?? Math.floor(Date.now() / 1000))
    );
  } catch {
    return false;
  }
}

export function devBackupAccessProjection(
  environment: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now,
): Record<string, string> {
  if (!devProductionDataEnabled(environment)) return {};
  const canonicalThreadId = environment.COMPADRE_CANONICAL_THREAD_ID?.trim();
  const secret = environment.COMPADRE_DEV_BACKUP_ACCESS_SECRET?.trim();
  const publicUrl = environment.COMPADRE_PUBLIC_URL?.trim();
  if (!canonicalThreadId || !UUID_PATTERN.test(canonicalThreadId)) {
    throw new Error(
      "COMPADRE_CANONICAL_THREAD_ID must be a UUID for backup access",
    );
  }
  if (!secret || !publicUrl) {
    throw new Error(
      "COMPADRE_DEV_BACKUP_ACCESS_SECRET and COMPADRE_PUBLIC_URL are required for production-derived development data",
    );
  }
  const tokenTtl = integerSetting(
    "COMPADRE_DEV_BACKUP_TOKEN_TTL_SECONDS",
    environment.COMPADRE_DEV_BACKUP_TOKEN_TTL_SECONDS,
    DEFAULT_TOKEN_TTL_SECONDS,
    DEFAULT_TOKEN_TTL_SECONDS,
  );
  const endpoint = new URL(
    `/internal/dev-backups/${canonicalThreadId.toLowerCase()}/latest`,
    publicUrl,
  );
  return {
    COMPADRE_DEV_BACKUP_MANIFEST_URL: endpoint.toString(),
    COMPADRE_DEV_BACKUP_TOKEN: issueDevBackupAccessToken({
      canonicalThreadId,
      secret,
      expiresAtSeconds: Math.floor(now() / 1000) + tokenTtl,
    }),
  };
}

export interface DevBackupObject {
  key: string;
  lastModified: Date;
  sizeBytes: number;
}

export interface LatestDevBackupOptions {
  list?: (input: {
    bucket: string;
    prefix: string;
    region: string;
  }) => Promise<ReadonlyArray<DevBackupObject>>;
  sign?: (input: {
    bucket: string;
    key: string;
    region: string;
    expiresIn: number;
  }) => Promise<string>;
  now?: () => number;
}

export async function latestDevBackup(
  environment: NodeJS.ProcessEnv = process.env,
  options: LatestDevBackupOptions = {},
): Promise<LatestDevBackup | null> {
  const bucket =
    environment.COMPADRE_DEV_BACKUP_BUCKET?.trim() || DEFAULT_BUCKET;
  const prefix =
    environment.COMPADRE_DEV_BACKUP_PREFIX?.trim() || DEFAULT_PREFIX;
  const region =
    environment.COMPADRE_DEV_BACKUP_REGION?.trim() ||
    environment.AWS_REGION?.trim() ||
    DEFAULT_REGION;
  const expiresIn = integerSetting(
    "COMPADRE_DEV_BACKUP_DOWNLOAD_TTL_SECONDS",
    environment.COMPADRE_DEV_BACKUP_DOWNLOAD_TTL_SECONDS,
    DEFAULT_DOWNLOAD_TTL_SECONDS,
    604_800,
  );
  let client: S3Client | undefined;
  const s3 = () => (client ??= new S3Client({ region }));
  const list =
    options.list ??
    (async (input) => {
      const objects: DevBackupObject[] = [];
      let continuationToken: string | undefined;
      do {
        const response: ListObjectsV2CommandOutput = await s3().send(
          new ListObjectsV2Command({
            Bucket: input.bucket,
            Prefix: input.prefix,
            MaxKeys: 1_000,
            ...(continuationToken
              ? { ContinuationToken: continuationToken }
              : {}),
          }),
        );
        objects.push(
          ...(response.Contents ?? []).flatMap((object) =>
            object.Key && object.LastModified
              ? [
                  {
                    key: object.Key,
                    lastModified: object.LastModified,
                    sizeBytes: object.Size ?? 0,
                  },
                ]
              : [],
          ),
        );
        continuationToken = response.IsTruncated
          ? response.NextContinuationToken
          : undefined;
      } while (continuationToken);
      return objects;
    });
  const sign =
    options.sign ??
    (async (input) =>
      getSignedUrl(
        s3(),
        new GetObjectCommand({ Bucket: input.bucket, Key: input.key }),
        { expiresIn: input.expiresIn },
      ));
  const objects = await list({ bucket, prefix, region });
  const latest = [...objects].sort(
    (left, right) => right.lastModified.getTime() - left.lastModified.getTime(),
  )[0];
  if (!latest) return null;
  const now = options.now?.() ?? Date.now();
  return {
    bucket,
    key: latest.key,
    lastModified: latest.lastModified.toISOString(),
    sizeBytes: latest.sizeBytes,
    downloadUrl: await sign({
      bucket,
      key: latest.key,
      region,
      expiresIn,
    }),
    expiresAt: new Date(now + expiresIn * 1_000).toISOString(),
  };
}
