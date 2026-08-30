import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { configuredBackupToken, createSqliteBackup } from "./CompadreBackup.ts";

describe("Compadre SQLite backup", () => {
  it("requires a dedicated backup credential", () => {
    assert.equal(
      configuredBackupToken({
        COMPADRE_API_KEY: "provider-key",
        COMPADRE_T3_CENTRAL_TOKEN: "session-key",
      }),
      null,
    );
    assert.equal(configuredBackupToken({ COMPADRE_BACKUP_TOKEN: "  backup-key  " }), "backup-key");
  });

  it.effect("creates a consistent standalone copy of a WAL database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = path.join("/tmp", `compadre-t3-backup-${randomUUID()}`);
      yield* fs.makeDirectory(directory, { recursive: true });
      const sourcePath = path.join(directory, "state.sqlite");
      const source = new DatabaseSync(sourcePath);
      try {
        source.exec(
          "PRAGMA journal_mode=WAL; CREATE TABLE messages (id INTEGER PRIMARY KEY, text TEXT NOT NULL);",
        );
        source.prepare("INSERT INTO messages (text) VALUES (?)").run("durable message");
        const artifact = yield* createSqliteBackup(sourcePath);
        assert.ok(artifact.bytes.byteLength > 0);
        assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
        const restoredPath = path.join(directory, "restored.sqlite");
        yield* fs.writeFile(restoredPath, artifact.bytes);
        const restored = new DatabaseSync(restoredPath, { readOnly: true });
        try {
          const row = restored.prepare("SELECT text FROM messages").get() as {
            text: string;
          };
          assert.equal(row.text, "durable message");
        } finally {
          restored.close();
        }
      } finally {
        source.close();
        yield* fs.remove(directory, { recursive: true, force: true });
      }
    }).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])),
  );
});
