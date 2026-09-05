import { CENTRAL_SQLITE_TABLES } from "../CompadrePersistenceTables.ts";
import pg from "pg";
import { PgClient } from "@effect/sql-pg";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migration001Initial } from "../CompadrePostgresSchema.ts";
import { PersistenceBackend, PersistenceReadClient } from "../Services/PersistenceBackend.ts";

export const POSTGRES_SCHEMA_VERSION = 1;
export const SQLITE_SCHEMA_VERSION = 44;

const migrate = Migrator.make({})({
  loader: Migrator.fromRecord({ "1_compadre_initial": migration001Initial }),
  table: "compadre_t3_migrations",
});

/** Only the explicit migration CLI runs DDL; application startup validates it. */
export const runPostgresMigrations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`SELECT pg_advisory_xact_lock(hashtextextended('compadre_t3_migrations', 0))`;
      yield* sql`CREATE SCHEMA IF NOT EXISTS compadre_t3`;
      const tables = yield* sql<{
        name: string;
      }>`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`;
      const centralTables = new Set<string>([
        ...CENTRAL_SQLITE_TABLES,
        "orchestration_commit_order",
        "compadre_t3_attachment_objects",
      ]);
      if (
        !tables.some((table) => table.name === "compadre_t3_migrations") &&
        tables.some((table) => centralTables.has(table.name))
      ) {
        return yield* Effect.die(
          new Error("Refusing to adopt existing central tables without central migration history."),
        );
      }
      yield* sql`CREATE TABLE IF NOT EXISTS compadre_t3_migrations (
      migration_id INTEGER PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      name TEXT NOT NULL
    )`;
      return yield* migrate;
    }),
  );
});

/** Read queries cannot consume the four connections reserved for command transactions. */
export const makePostgresClientLive = (url: string) =>
  Layer.effectContext(
    Effect.gen(function* () {
      // Apply to every pooled and LISTEN connection; keep central queries out of the controller schema.
      const connectionUrl = new URL(url);
      const connectionOptions = connectionUrl.searchParams.get("options");
      connectionUrl.searchParams.set(
        "options",
        `${connectionOptions ? `${connectionOptions} ` : ""}-c search_path=compadre_t3`,
      );
      const options = {
        types: {
          getTypeParser: (oid: number, format?: "text" | "binary") => {
            if (oid !== 20 || format === "binary") return pg.types.getTypeParser(oid, format);
            return (value: string) => {
              const parsed = Number(value);
              if (!Number.isSafeInteger(parsed))
                throw new Error("PostgreSQL integer exceeds the T3 safe integer contract.");
              return parsed;
            };
          },
        },
        url: Redacted.make(connectionUrl.toString()),
        connectTimeout: "5 seconds" as const,
      };
      const reads = yield* PgClient.make({
        ...options,
        applicationName: "compadre-central-reads",
        maxConnections: 8,
      });
      const writes = yield* PgClient.make({
        ...options,
        applicationName: "compadre-central-writes",
        maxConnections: 4,
      });
      const sql = yield* SqlClient.make({
        acquirer: reads.reserve,
        transactionAcquirer: writes.reserve,
        compiler: PgClient.makeCompiler(),
        spanAttributes: [["service.name", "compadre-web"]],
      });
      const readSql = yield* SqlClient.make({
        acquirer: reads.reserve,
        compiler: PgClient.makeCompiler(),
        transactionService: sql.transactionService,
        beginTransaction: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
        spanAttributes: [["service.name", "compadre-web"]],
      });
      yield* sql`SELECT 1`;
      return Context.make(SqlClient.SqlClient, sql).pipe(
        Context.add(PgClient.PgClient, reads),
        Context.add(PersistenceReadClient, readSql),
      );
    }),
  ).pipe(Layer.provide(Reactivity.layer));

export const makePostgresPersistenceLive = (url: string) => {
  const client = makePostgresClientLive(url);
  const backend = Layer.effect(
    PersistenceBackend,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const postgres = yield* PgClient.PgClient;
      const versions = yield* sql<{
        version: number | null;
      }>`SELECT MAX(migration_id) AS version FROM compadre_t3_migrations`;
      if (versions[0]?.version !== POSTGRES_SCHEMA_VERSION) {
        return yield* Effect.die(
          new Error(
            "Central PostgreSQL schema is not current; run migrate-postgres before serving.",
          ),
        );
      }
      return PersistenceBackend.of({
        kind: "postgres",
        lockOrchestrationKeys: (keys) =>
          Effect.forEach(
            [...new Map(keys.map((key) => [`${key.scope}\0${key.key}`, key])).values()].sort(
              (a, b) => a.scope.localeCompare(b.scope) || a.key.localeCompare(b.key),
            ),
            ({ scope, key }) =>
              sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, hashtextextended(${scope}, 0)))`,
            { concurrency: 1, discard: true },
          ),
        lockOrchestrationCommitOrder:
          sql`SELECT singleton_id FROM orchestration_commit_order WHERE singleton_id = 1 FOR UPDATE`.pipe(
            Effect.asVoid,
          ),
        listen: postgres.listen,
        notify: postgres.notify,
      });
    }),
  );
  return backend.pipe(Layer.provideMerge(client));
};

export const layerConfig = Layer.unwrap(
  Effect.sync(() => {
    const url = process.env.COMPADRE_T3_POSTGRES_URL?.trim();
    if (!url) throw new Error("COMPADRE_T3_POSTGRES_URL is required for PostgreSQL persistence.");
    return makePostgresPersistenceLive(url);
  }),
);
