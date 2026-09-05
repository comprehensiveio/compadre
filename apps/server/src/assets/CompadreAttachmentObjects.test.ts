// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeTestPostgresPersistence } from "../persistence/PostgresTest.ts";
import { makeAttachmentStore } from "./CompadreAttachmentObjects.ts";
const url = process.env.COMPADRE_T3_POSTGRES_TEST_URL;
describe.runIf(url)("Compadre durable attachment bytes", () => {
  it.effect(
    "restores an empty local directory from objects and rejects corrupt or changed bytes",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`TRUNCATE TABLE compadre_t3_attachment_objects`;
        const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "compadre-objects-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
        );
        const fs = yield* FileSystem.FileSystem;
        const objects = new Map<string, Uint8Array>();
        const store = yield* makeAttachmentStore(
          {
            put: async (key, bytes) => {
              objects.set(key, bytes);
            },
            get: async (key) => {
              const bytes = objects.get(key);
              if (!bytes) throw new Error("missing object");
              return bytes;
            },
          },
          directory,
        );
        const file = NodePath.join(directory, "attachment.png");
        yield* fs.writeFile(file, new Uint8Array([1, 2, 3]));
        yield* store.persist(file);
        yield* fs.remove(file);
        yield* store.restore;
        expect([...(yield* fs.readFile(file))]).toEqual([1, 2, 3]);
        yield* fs.writeFile(file, new Uint8Array([4, 5]));
        expect(Exit.isFailure(yield* store.persist(file).pipe(Effect.exit))).toBe(true);
        for (const key of objects.keys()) objects.set(key, new Uint8Array([9]));
        expect(Exit.isFailure(yield* store.restore.pipe(Effect.exit))).toBe(true);
        const rows = yield* sql<{
          count: string;
        }>`SELECT COUNT(*)::text AS count FROM compadre_t3_attachment_objects`;
        expect(rows[0]?.count).toBe("1");
        yield* sql`TRUNCATE TABLE compadre_t3_attachment_objects`;
      }).pipe(
        Effect.provide([makeTestPostgresPersistence(url!), NodeServices.layer]),
        Effect.scoped,
      ),
  );
});
