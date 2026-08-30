import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { MetadataStore } from "./storage.js";

export const MAX_T3_ARTIFACT_BYTES = 25 * 1024 * 1024;
const METADATA_NAMESPACE = "compadre.t3.output-artifacts.v1";

export interface T3ArtifactMetadata {
  runId: string;
  artifactId: string;
  objectKey: string;
  path: string;
  name: string;
  title: string;
  mimetype: string;
  sizeBytes: number;
  createdAt: string;
}

export interface T3ArtifactObjectStore {
  put(input: {
    key: string;
    artifactId: string;
    mimetype: string;
    bytes: Uint8Array;
  }): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  check(): Promise<void>;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertArtifactId(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("T3 artifact id must be a lowercase SHA-256 digest");
  }
}

function assertSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_T3_ARTIFACT_BYTES) {
    throw new Error(`T3 artifact exceeds the ${MAX_T3_ARTIFACT_BYTES}-byte limit`);
  }
}

export function t3ArtifactObjectKey(runId: string, artifactId: string): string {
  assertArtifactId(artifactId);
  return `attachments/v1/${sha256(runId)}/${artifactId}`;
}

function metadataKey(runId: string, artifactId: string): string {
  return `${sha256(runId)}:${artifactId}`;
}

function decodeMetadata(value: unknown): T3ArtifactMetadata {
  if (!value || typeof value !== "object") throw new Error("Invalid T3 artifact metadata");
  const record = value as Record<string, unknown>;
  for (const field of [
    "runId", "artifactId", "objectKey", "path", "name", "title",
    "mimetype", "createdAt",
  ]) {
    if (typeof record[field] !== "string") throw new Error("Invalid T3 artifact metadata");
  }
  if (!Number.isSafeInteger(record.sizeBytes) || Number(record.sizeBytes) < 0) {
    throw new Error("Invalid T3 artifact metadata");
  }
  return record as unknown as T3ArtifactMetadata;
}

function preconditionFailed(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return candidate.name === "PreconditionFailed" || candidate.$metadata?.httpStatusCode === 412;
}

export class S3T3ArtifactObjectStore implements T3ArtifactObjectStore {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    options: { region: string; client?: S3Client },
  ) {
    this.client = options.client ?? new S3Client({ region: options.region });
  }

  async put(input: {
    key: string;
    artifactId: string;
    mimetype: string;
    bytes: Uint8Array;
  }): Promise<void> {
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.bytes,
        ContentLength: input.bytes.byteLength,
        ContentType: input.mimetype,
        IfNoneMatch: "*",
        Metadata: { sha256: input.artifactId },
        ServerSideEncryption: "AES256",
      }));
      return;
    } catch (error) {
      if (!preconditionFailed(error)) throw error;
    }
    const existing = await this.client.send(new HeadObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
    }));
    if (
      existing.ContentLength !== input.bytes.byteLength ||
      existing.Metadata?.sha256 !== input.artifactId
    ) {
      throw new Error(`T3 artifact object collision at ${input.key}`);
    }
  }

  async get(key: string): Promise<Uint8Array> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body) throw new Error(`T3 artifact object ${key} has no body`);
    return result.Body.transformToByteArray();
  }

  async check(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }
}

export class T3ArtifactStore {
  constructor(
    private readonly objects: T3ArtifactObjectStore,
    private readonly metadata: MetadataStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async publish(input: {
    runId: string;
    artifactId: string;
    path: string;
    name: string;
    title: string;
    mimetype: string;
    bytes: Uint8Array;
  }): Promise<T3ArtifactMetadata> {
    assertArtifactId(input.artifactId);
    assertSize(input.bytes.byteLength);
    if (sha256(input.bytes) !== input.artifactId) {
      throw new Error("T3 artifact bytes do not match their SHA-256 id");
    }
    const objectKey = t3ArtifactObjectKey(input.runId, input.artifactId);
    await this.objects.put({
      key: objectKey,
      artifactId: input.artifactId,
      mimetype: input.mimetype,
      bytes: input.bytes,
    });
    const stored: T3ArtifactMetadata = {
      runId: input.runId,
      artifactId: input.artifactId,
      objectKey,
      path: input.path,
      name: input.name,
      title: input.title,
      mimetype: input.mimetype,
      sizeBytes: input.bytes.byteLength,
      createdAt: this.now().toISOString(),
    };
    await this.metadata.set(
      METADATA_NAMESPACE,
      metadataKey(input.runId, input.artifactId),
      stored,
    );
    return stored;
  }

  async read(runId: string, artifactId: string): Promise<{
    metadata: T3ArtifactMetadata;
    bytes: Uint8Array;
  } | null> {
    assertArtifactId(artifactId);
    const value = await this.metadata.get(
      METADATA_NAMESPACE,
      metadataKey(runId, artifactId),
    );
    if (value === null) return null;
    const metadata = decodeMetadata(value);
    if (metadata.runId !== runId || metadata.artifactId !== artifactId) {
      throw new Error("T3 artifact metadata identity mismatch");
    }
    const bytes = await this.objects.get(metadata.objectKey);
    assertSize(bytes.byteLength);
    if (bytes.byteLength !== metadata.sizeBytes || sha256(bytes) !== artifactId) {
      throw new Error(`T3 artifact ${artifactId} failed integrity validation`);
    }
    return { metadata, bytes };
  }

  check(): Promise<void> {
    return this.objects.check();
  }
}
