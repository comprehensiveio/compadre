import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const T3_SERVER_PORT = 3773;
export const COMP_DEV_SERVER_PORT = 3000;
const DEFAULT_BUCKET = "compadre";
const DEFAULT_PREFIX = "dev-environments/comp";
// A thread snapshot can be resumed for seven days. Keep its read-only object
// credentials valid for the same window so lazily starting a dev server on a
// later turn does not inherit already-expired bootstrap URLs.
const DEFAULT_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

export function devEnvironmentEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment.COMPADRE_DEV_ENVIRONMENT_ENABLED?.trim() === "true";
}

export function t3EncryptedPorts(
  environment: NodeJS.ProcessEnv = process.env,
): number[] {
  return devEnvironmentEnabled(environment)
    ? [T3_SERVER_PORT, COMP_DEV_SERVER_PORT]
    : [T3_SERVER_PORT];
}

export interface DevArtifactSigner {
  (input: {
    bucket: string;
    key: string;
    region: string;
    expiresIn: number;
  }): Promise<string>;
}

function artifactKey(prefix: string, filename: string): string {
  return `${prefix.replace(/^\/+|\/+$/g, "")}/${filename}`;
}

/**
 * Mint short-lived, read-only URLs for immutable sandbox bootstrap inputs.
 * Signing is local at worker creation; S3 is contacted only when the agent
 * actually runs the repository's lazy development command.
 */
export async function devEnvironmentArtifactProjection(
  environment: NodeJS.ProcessEnv = process.env,
  options: { sign?: DevArtifactSigner } = {},
): Promise<Record<string, string>> {
  if (!devEnvironmentEnabled(environment)) return {};

  const bucket =
    environment.COMPADRE_DEV_ARTIFACT_BUCKET?.trim() || DEFAULT_BUCKET;
  const prefix =
    environment.COMPADRE_DEV_ARTIFACT_PREFIX?.trim() || DEFAULT_PREFIX;
  const region =
    environment.COMPADRE_DEV_ARTIFACT_REGION?.trim() ||
    environment.AWS_REGION?.trim() ||
    "us-west-2";
  const expiresIn = Number(
    environment.COMPADRE_DEV_ARTIFACT_URL_TTL_SECONDS ||
      DEFAULT_URL_TTL_SECONDS,
  );
  if (!Number.isInteger(expiresIn) || expiresIn < 60 || expiresIn > 604_800) {
    throw new Error(
      "COMPADRE_DEV_ARTIFACT_URL_TTL_SECONDS must be an integer from 60 to 604800",
    );
  }

  let client: S3Client | undefined;
  const sign =
    options.sign ??
    (async (input) => {
      client ??= new S3Client({ region: input.region });
      return getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: input.bucket, Key: input.key }),
        { expiresIn: input.expiresIn },
      );
    });
  const entries = await Promise.all(
    [
      ["SEED_URL", "seed-latest.tar"],
      ["PREBUILT_URL", "deps-prebuilt-amd64-latest.tar.zst"],
      ["PGDATA_URL", "pgdata-amd64-latest.tar.zst"],
      ["VITE_CACHE_URL", "vite-cache-latest.tar.gz"],
    ].map(async ([name, filename]) => [
      name,
      await sign({
        bucket,
        key: artifactKey(prefix, filename),
        region,
        expiresIn,
      }),
    ]),
  );
  return Object.fromEntries(entries);
}
