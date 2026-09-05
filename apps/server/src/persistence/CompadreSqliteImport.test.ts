// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CENTRAL_SQLITE_TABLES, importSqliteSnapshot } from "./CompadreSqliteImport.ts";
import { makeTestPostgresPersistence } from "./PostgresTest.ts";
import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";
import { SQLITE_SCHEMA_VERSION } from "./Layers/Postgres.ts";
import { migrationManifest } from "./Migrations.ts";

const url = process.env.COMPADRE_T3_POSTGRES_TEST_URL;
const quote = (name: string) => `"${name}"`;
const snapshot = Effect.gen(function* () {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "compadre-import-"));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
  );
  const path = NodePath.join(directory, "state.sqlite");
  yield* Effect.void.pipe(
    Effect.provide(makeSqlitePersistenceLive(path).pipe(Layer.provide(NodeServices.layer))),
    Effect.scoped,
  );
  const source = new NodeSqlite.DatabaseSync(path);
  for (const table of CENTRAL_SQLITE_TABLES) {
    const columns = source.prepare(`PRAGMA table_info(${quote(table)})`).all();
    const names = columns.map((column) => String(column.name));
    const values = columns.map((column) => {
      const name = String(column.name);
      if (column.type === "INTEGER")
        return name === "sequence" ||
          name === "row_id" ||
          name === "last_applied_sequence" ||
          name === "result_sequence"
          ? 3_000_000_001
          : 1;
      if (name.endsWith("_json")) return '{ "z": 9007199254740993, "unicode": "é雪", "nil": null }';
      if (name.endsWith("_at")) return "2026-09-05T12:00:00.123456Z";
      if (name === "aggregate_kind") return "thread";
      if (name === "event_type") return "thread.created";
      return column.notnull || column.pk ? `${table}:${name}` : null;
    });
    source
      .prepare(
        `INSERT INTO ${quote(table)} (${names.map(quote).join(",")}) VALUES (${names.map(() => "?").join(",")})`,
      )
      .run(...values);
  }
  source.close();
  return {
    path,
    sha256: NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex"),
  };
});

it("requires a PostgreSQL review when the SQLite migration registry changes", () => {
  expect(migrationManifest.at(-1)?.[0]).toBe(SQLITE_SCHEMA_VERSION);
});

describe.runIf(url)("Compadre schema parity and import", () => {
  it.effect(
    "matches every SQLite column and imports every cell, including large sequences and exact JSON",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const table of CENTRAL_SQLITE_TABLES)
          yield* sql`TRUNCATE TABLE ${sql(table)} RESTART IDENTITY`;
        yield* sql`CREATE TABLE public.compadre_controller_import_fixture (id TEXT PRIMARY KEY)`;
        yield* sql`INSERT INTO public.compadre_controller_import_fixture VALUES ('preserved')`;
        yield* Effect.addFinalizer(() =>
          sql`DROP TABLE public.compadre_controller_import_fixture`.pipe(Effect.orDie),
        );
        const fixture = yield* snapshot;
        const report = yield* importSqliteSnapshot(fixture.path, fixture.sha256);
        const controller = yield* sql<{
          id: string;
        }>`SELECT id FROM public.compadre_controller_import_fixture`;
        expect([...controller]).toEqual([{ id: "preserved" }]);
        expect(report.tables).toHaveLength(15);
        expect(report.tables.every((table) => table.rows === 1)).toBe(true);
        expect(report.eventRange).toEqual([
          { count: "1", minimum: 3_000_000_001, maximum: 3_000_000_001 },
        ]);
        const next = yield* sql<{
          next: number;
        }>`SELECT nextval('orchestration_events_sequence_seq') AS next`;
        expect(next[0]?.next).toBe(3_000_000_002);
        expect(report.streamHeads).toBe(1);
        expect(report.projectionCursors).toHaveLength(1);
        expect(
          Exit.isFailure(
            yield* importSqliteSnapshot(fixture.path, fixture.sha256).pipe(Effect.exit),
          ),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* importSqliteSnapshot(fixture.path, "0".repeat(64)).pipe(Effect.exit),
          ),
        ).toBe(true);
        const rows = yield* sql<{
          count: string;
        }>`SELECT COUNT(*)::text AS count FROM orchestration_events`;
        expect(rows[0]?.count).toBe("1");
      }).pipe(Effect.scoped, Effect.provide(makeTestPostgresPersistence(url!)), Effect.scoped),
  );

  it.effect("rolls back all imported tables on a verification mismatch", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const table of CENTRAL_SQLITE_TABLES)
        yield* sql`TRUNCATE TABLE ${sql(table)} RESTART IDENTITY`;
      const fixture = yield* snapshot;
      yield* sql`CREATE OR REPLACE FUNCTION test_corrupt_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = 'corrupted'; RETURN NEW; END $$`;
      yield* sql`CREATE TRIGGER test_corrupt_import BEFORE INSERT ON projection_state FOR EACH ROW EXECUTE FUNCTION test_corrupt_import()`;
      const result = yield* importSqliteSnapshot(fixture.path, fixture.sha256).pipe(Effect.exit);
      yield* sql`DROP TRIGGER test_corrupt_import ON projection_state`;
      yield* sql`DROP FUNCTION test_corrupt_import()`;
      expect(Exit.isFailure(result)).toBe(true);
      for (const table of CENTRAL_SQLITE_TABLES) {
        const rows = yield* sql<{
          count: string;
        }>`SELECT COUNT(*)::text AS count FROM ${sql(table)}`;
        expect(rows[0]?.count, table).toBe("0");
      }
    }).pipe(Effect.provide(makeTestPostgresPersistence(url!)), Effect.scoped),
  );
});
