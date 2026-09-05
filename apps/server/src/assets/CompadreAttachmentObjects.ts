// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { CompadreAttachmentStore, AttachmentObjectError } from "./CompadreAttachmentStore.ts";

export interface AttachmentObjects {
  put: (key: string, bytes: Uint8Array, sha256: string) => Promise<void>;
  get: (key: string) => Promise<Uint8Array>;
}

const digest = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** Content-addressed S3 bytes commit before metadata or conversation publication. */
export const makeAttachmentStore = Effect.fn("makeAttachmentStore")(function* (
  objects: AttachmentObjects,
  attachmentsDir: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(attachmentsDir);
  const relative = (absolutePath: string) => {
    const name = path.relative(root, absolutePath);
    if (
      !name ||
      name.startsWith("..") ||
      path.isAbsolute(name) ||
      name.includes("\\") ||
      name.endsWith(".part")
    ) {
      throw new Error("Unsafe attachment object path.");
    }
    return name;
  };
  const persist = Effect.fn("CompadreAttachmentStore.persist")(
    function* (absolutePath: string) {
      const name = relative(absolutePath);
      const info = yield* fs.stat(absolutePath);
      if (info.type !== "File")
        return yield* Effect.fail(
          new AttachmentObjectError({ message: "Attachment must be a regular file." }),
        );
      const bytes = yield* fs.readFile(absolutePath);
      const sha256 = digest(bytes);
      const key = `attachments/v1/central-t3/${sha256}`;
      yield* Effect.tryPromise(() => objects.put(key, bytes, sha256));
      // A read-back verifies both integrity and restore permission before acknowledging the upload.
      const stored = yield* Effect.tryPromise(() => objects.get(key));
      if (stored.byteLength !== bytes.byteLength || digest(stored) !== sha256) {
        return yield* Effect.fail(
          new AttachmentObjectError({
            message: "Attachment object failed read-back integrity validation.",
          }),
        );
      }
      const rows =
        yield* sql`INSERT INTO compadre_t3_attachment_objects (relative_path, object_key, sha256, size_bytes)
      VALUES (${name}, ${key}, ${sha256}, ${bytes.byteLength})
      ON CONFLICT (relative_path) DO UPDATE SET relative_path = excluded.relative_path
      WHERE compadre_t3_attachment_objects.sha256 = excluded.sha256
      RETURNING relative_path`;
      if (rows.length !== 1)
        return yield* Effect.fail(
          new AttachmentObjectError({ message: "An attachment path cannot change its content." }),
        );
    },
    Effect.mapError(
      (cause) =>
        new AttachmentObjectError({ message: "Failed to durably store attachment.", cause }),
    ),
  );

  const restore = Effect.gen(function* () {
    const rows = yield* sql<{
      relative_path: string;
      object_key: string;
      sha256: string;
      size_bytes: number;
    }>`SELECT * FROM compadre_t3_attachment_objects ORDER BY relative_path`;
    yield* Effect.forEach(
      rows,
      (row) =>
        Effect.gen(function* () {
          const destination = path.join(root, row.relative_path);
          relative(destination);
          const bytes = yield* Effect.tryPromise(() => objects.get(row.object_key));
          if (bytes.byteLength !== row.size_bytes || digest(bytes) !== row.sha256) {
            return yield* Effect.fail(
              new AttachmentObjectError({ message: "Attachment restore integrity mismatch." }),
            );
          }
          yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
          const temporary = `${destination}.${NodeCrypto.randomUUID()}.part`;
          yield* fs.writeFile(temporary, bytes);
          yield* fs.rename(temporary, destination);
        }),
      { concurrency: 4, discard: true },
    );
  });
  return { persist, restore };
});

export const makeS3AttachmentObjects = Effect.gen(function* () {
  const bucket = process.env.COMPADRE_T3_ATTACHMENT_BUCKET?.trim();
  const region = process.env.COMPADRE_T3_ATTACHMENT_REGION?.trim();
  if (!bucket || !region)
    return yield* Effect.die(
      new Error(
        "PostgreSQL hosted mode requires COMPADRE_T3_ATTACHMENT_BUCKET and COMPADRE_T3_ATTACHMENT_REGION.",
      ),
    );
  const client = yield* Effect.acquireRelease(
    Effect.sync(() => new S3Client({ region })),
    (s3) => Effect.sync(() => s3.destroy()),
  );
  return {
    put: async (key: string, bytes: Uint8Array, sha256: string) => {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentLength: bytes.byteLength,
          ServerSideEncryption: "AES256",
          Metadata: { sha256 },
          ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
        }),
      );
    },
    get: async (key: string) => {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!response.Body) throw new Error("Attachment object has no body.");
      return response.Body.transformToByteArray();
    },
  } satisfies AttachmentObjects;
});

export const layer = Layer.effect(
  CompadreAttachmentStore,
  Effect.gen(function* () {
    const { attachmentsDir } = yield* ServerConfig;
    const store = yield* makeAttachmentStore(yield* makeS3AttachmentObjects, attachmentsDir);
    yield* store.restore;
    return store;
  }),
);
