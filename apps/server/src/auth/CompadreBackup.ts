import { usesPostgresPersistence } from "../persistence/Layers/Persistence.ts";
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";

function equalSecret(actual: string | undefined, expected: string): boolean {
  if (!actual?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(actual.slice("Bearer ".length).trim());
  const configured = Buffer.from(expected);
  return supplied.length === configured.length && NodeCrypto.timingSafeEqual(supplied, configured);
}

export interface SqliteBackupArtifact {
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export function configuredBackupToken(environment: NodeJS.ProcessEnv = process.env): string | null {
  return environment.COMPADRE_BACKUP_TOKEN?.trim() || null;
}

/** Use SQLite's online backup API so the live WAL database remains writable. */
export const createSqliteBackup = Effect.fn("CompadreBackup.createSqliteBackup")(function* (
  dbPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const destination = path.join(
    path.dirname(dbPath),
    `.compadre-backup-${NodeCrypto.randomUUID()}.sqlite`,
  );
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(dbPath, { readOnly: true })),
    (source) =>
      Effect.gen(function* () {
        yield* Effect.tryPromise(() => NodeSqlite.backup(source, destination, { rate: 100 }));
        yield* Effect.acquireUseRelease(
          Effect.sync(() => new NodeSqlite.DatabaseSync(destination, { readOnly: true })),
          (verification) =>
            Effect.sync(() => {
              const integrity = verification.prepare("PRAGMA integrity_check").get() as
                | Record<string, unknown>
                | undefined;
              if (!integrity || !Object.values(integrity).includes("ok")) {
                throw new Error("SQLite backup failed its integrity check");
              }
            }),
          (verification) => Effect.sync(() => verification.close()),
        );
        const bytes = yield* fs.readFile(destination);
        return {
          bytes,
          sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
        } satisfies SqliteBackupArtifact;
      }).pipe(Effect.ensuring(fs.remove(destination).pipe(Effect.ignore))),
    (source) => Effect.sync(() => source.close()),
  );
});

const route = HttpRouter.add(
  "GET",
  "/internal/compadre/state-backup",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const token = configuredBackupToken();
    if (!token || !equalSecret(request.headers.authorization, token)) {
      return HttpServerResponse.text("Unauthorized", {
        status: 401,
        headers: { "cache-control": "no-store" },
      });
    }
    if (usesPostgresPersistence()) {
      return HttpServerResponse.text("Central state is backed up by PostgreSQL operations.", {
        status: 410,
        headers: { "cache-control": "no-store", "x-compadre-backup-backend": "postgres" },
      });
    }
    const config = yield* ServerConfig.ServerConfig;
    const artifact = yield* createSqliteBackup(config.dbPath);
    return HttpServerResponse.uint8Array(artifact.bytes, {
      contentType: "application/vnd.sqlite3",
      headers: {
        "cache-control": "no-store",
        "content-disposition": 'attachment; filename="compadre-t3-state.sqlite"',
        "x-compadre-sha256": artifact.sha256,
      },
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Compadre SQLite backup failed", { cause }).pipe(
        Effect.as(HttpServerResponse.text("Backup failed", { status: 500 })),
      ),
    ),
  ),
);

export const compadreBackupRouteLayer = Layer.mergeAll(route);
