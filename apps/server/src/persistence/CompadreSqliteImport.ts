// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { migrationManifest } from "./Migrations.ts";

import { CENTRAL_SQLITE_TABLES } from "./CompadrePersistenceTables.ts";
export { CENTRAL_SQLITE_TABLES } from "./CompadrePersistenceTables.ts";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const canonicalRow = (row: Readonly<Record<string, unknown>>) =>
  JSON.stringify(
    Object.keys(row)
      .sort()
      .map((key) => [key, row[key]]),
  ) + "\n";

/** Imports a closed, verified snapshot. Every cell is compared before the transaction commits. */
export const importSqliteSnapshot = Effect.fn("importSqliteSnapshot")(function* (
  snapshotPath: string,
  expectedSha256: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const sha256 = NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(snapshotPath))
    .digest("hex");
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || sha256 !== expectedSha256) {
    return yield* Effect.die(
      new Error("Snapshot SHA-256 does not match the immutable audit artifact."),
    );
  }
  try {
    if (NodeFS.statSync(`${snapshotPath}-wal`).size > 0)
      throw new Error("Use a standalone SQLite backup snapshot, not a live WAL database.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const source = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(snapshotPath, { readOnly: true })),
    (database) => Effect.sync(() => database.close()),
  );
  source.exec("PRAGMA query_only = ON; BEGIN");
  const integrity = source.prepare("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    return yield* Effect.die(new Error("SQLite integrity_check must return exactly ok."));
  }
  const tables = source
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'effect_sql_migrations'",
    )
    .all()
    .map((row) => String(row.name))
    .sort();
  if (JSON.stringify(tables) !== JSON.stringify([...CENTRAL_SQLITE_TABLES].sort())) {
    return yield* Effect.die(
      new Error("SQLite table inventory differs from the supported Compadre schema."),
    );
  }
  const migrations = source
    .prepare("SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id")
    .all()
    .map((row) => [row.migration_id, row.name]);
  if (JSON.stringify(migrations) !== JSON.stringify(migrationManifest)) {
    return yield* Effect.die(
      new Error(
        "SQLite migration history must exactly match this binary; migrate a separate copy first.",
      ),
    );
  }

  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`SELECT singleton_id FROM orchestration_commit_order WHERE singleton_id = 1 FOR UPDATE`;
      for (const table of [...CENTRAL_SQLITE_TABLES, "compadre_t3_attachment_objects"].sort()) {
        yield* sql`LOCK TABLE ${sql(table)} IN ACCESS EXCLUSIVE MODE`;
      }
      for (const table of CENTRAL_SQLITE_TABLES) {
        const rows = yield* sql<{
          count: string;
        }>`SELECT COUNT(*)::text AS count FROM ${sql(table)}`;
        if (rows[0]?.count !== "0")
          return yield* Effect.die(new Error(`Import target is not empty: ${table}`));
      }
      const report: Array<{ table: string; rows: number; sha256: string }> = [];
      for (const table of CENTRAL_SQLITE_TABLES) {
        const columns = source
          .prepare(`PRAGMA table_info(${quote(table)})`)
          .all()
          .map((row) => String(row.name))
          .sort();
        const targetColumns = yield* sql<{
          name: string;
        }>`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ${table}`;
        if (
          JSON.stringify(columns) !== JSON.stringify(targetColumns.map((row) => row.name).sort())
        ) {
          return yield* Effect.die(new Error(`Import column mismatch: ${table}`));
        }
        const order = columns.map((column) => `${quote(column)} NULLS FIRST`).join(", ");
        const sourceHash = NodeCrypto.createHash("sha256");
        let count = 0;
        let batch: Array<Record<string, unknown>> = [];
        for (const row of source
          .prepare(`SELECT * FROM ${quote(table)} ORDER BY ${order}`)
          .iterate()) {
          sourceHash.update(canonicalRow(row));
          count++;
          batch.push(row);
          if (batch.length === 256) {
            yield* sql`INSERT INTO ${sql(table)} ${sql.insert(batch)}`;
            batch = [];
          }
        }
        if (batch.length) yield* sql`INSERT INTO ${sql(table)} ${sql.insert(batch)}`;
        const targetHash = NodeCrypto.createHash("sha256");
        let targetCount = 0;
        // C collation matches SQLite BINARY ordering for text; numeric columns retain numeric order.
        const textColumns = new Set(
          source
            .prepare(`PRAGMA table_info(${quote(table)})`)
            .all()
            .filter((row) => row.type === "TEXT")
            .map((row) => String(row.name)),
        );
        const targetOrder = columns
          .map(
            (column) =>
              `${quote(column)}${textColumns.has(column) ? ' COLLATE "C"' : ""} NULLS FIRST`,
          )
          .join(", ");
        yield* sql
          .unsafe<Record<string, unknown>>(`SELECT * FROM ${quote(table)} ORDER BY ${targetOrder}`)
          .stream.pipe(
            Stream.runForEach((row) =>
              Effect.sync(() => {
                targetHash.update(canonicalRow(row));
                targetCount++;
              }),
            ),
          );
        const digest = sourceHash.digest("hex");
        if (targetCount !== count || targetHash.digest("hex") !== digest) {
          return yield* Effect.die(new Error(`Imported row verification failed: ${table}`));
        }
        report.push({ table, rows: count, sha256: digest });
      }
      // These checks are redundant with every-cell hashes, but make cutover evidence directly reviewable.
      const eventRange =
        yield* sql`SELECT COUNT(*)::text AS count, MIN(sequence) AS minimum, MAX(sequence) AS maximum FROM orchestration_events`;
      const heads =
        yield* sql`SELECT aggregate_kind, stream_id, MAX(stream_version) AS version FROM orchestration_events GROUP BY aggregate_kind, stream_id ORDER BY aggregate_kind, stream_id`;
      const cursors = yield* sql`SELECT * FROM projection_state ORDER BY projector`;
      for (const [table, column] of [
        ["orchestration_events", "sequence"],
        ["projection_turns", "row_id"],
      ] as const) {
        const highWater =
          source.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table)?.seq ?? 0;
        const maximum =
          source.prepare(`SELECT MAX(${quote(column)}) AS maximum FROM ${quote(table)}`).get()
            ?.maximum ?? 0;
        const next = Math.max(Number(highWater), Number(maximum)) + 1;
        if (!Number.isSafeInteger(next))
          return yield* Effect.die(new Error("Identity exceeds the safe integer contract."));
        // Unlike setval(), ALTER SEQUENCE RESTART rolls back with the import transaction.
        yield* sql.unsafe(`ALTER SEQUENCE ${quote(`${table}_${column}_seq`)} RESTART WITH ${next}`);
      }
      return {
        snapshotSha256: sha256,
        tables: report,
        eventRange,
        streamHeads: heads.length,
        projectionCursors: cursors,
      };
    }),
  );
});
