import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  makePostgresPersistenceLive,
  POSTGRES_SCHEMA_VERSION,
  runPostgresMigrations,
} from "./Layers/Postgres.ts";
import { makeTestPostgresPersistence } from "./PostgresTest.ts";
import { schemaIncompatibility } from "./PostgresSchemaCompatibility.ts";
import { PersistenceBackend } from "./Services/PersistenceBackend.ts";

describe("PostgreSQL application compatibility", () => {
  it("keeps exact-version databases working without a declaration", () => {
    expect(schemaIncompatibility(1, 1, null)).toBeUndefined();
  });

  it("requires migrations for older databases and an explicit declaration for newer ones", () => {
    expect(schemaIncompatibility(2, 1, null)).toMatch(/older/);
    expect(schemaIncompatibility(1, 2, null)).toMatch(/no compatibility declaration/);
    expect(schemaIncompatibility(1, null, null)).toMatch(/no valid migration/);
  });

  it("permits additive upgrades and rejects an application below the declared floor", () => {
    expect(
      schemaIncompatibility(1, 2, { schemaVersion: 2, minimumAppSchemaVersion: 1 }),
    ).toBeUndefined();
    expect(schemaIncompatibility(1, 2, { schemaVersion: 2, minimumAppSchemaVersion: 2 })).toMatch(
      /no longer supports/,
    );
  });

  it("rejects stale or malformed declarations even for the exact application version", () => {
    for (const declaration of [
      { schemaVersion: 1, minimumAppSchemaVersion: 1 },
      { schemaVersion: 2, minimumAppSchemaVersion: 0 },
      { schemaVersion: 2, minimumAppSchemaVersion: 3 },
      { schemaVersion: 2, minimumAppSchemaVersion: 1.5 },
    ]) {
      expect(schemaIncompatibility(2, 2, declaration)).toMatch(/invalid or stale/);
    }
  });
});

const url = process.env.COMPADRE_T3_POSTGRES_TEST_URL;

describe.runIf(url)("PostgreSQL application rollback", () => {
  const persistence = () => makeTestPostgresPersistence(url!);
  const futureVersion = POSTGRES_SCHEMA_VERSION + 1;

  const installFutureSchema = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.addFinalizer(() =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`CREATE TABLE IF NOT EXISTS compadre_t3_schema_compatibility (
              singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1), schema_version INTEGER NOT NULL, minimum_app_schema_version INTEGER NOT NULL
            )`;
            yield* sql`INSERT INTO compadre_t3_schema_compatibility VALUES (1, ${POSTGRES_SCHEMA_VERSION}, 1)
              ON CONFLICT(singleton_id) DO UPDATE SET schema_version = excluded.schema_version, minimum_app_schema_version = excluded.minimum_app_schema_version`;
            yield* sql`DROP TABLE IF EXISTS compadre_future_events_fixture`;
            yield* sql`DELETE FROM compadre_t3_migrations WHERE migration_id = ${futureVersion}`;
            yield* sql`DELETE FROM projection_projects WHERE project_id = 'rollback-existing-project'`;
          }),
        )
        .pipe(Effect.orDie),
    );
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`CREATE TABLE compadre_future_events_fixture (id TEXT PRIMARY KEY)`;
        yield* sql`CREATE TABLE IF NOT EXISTS compadre_t3_schema_compatibility (
          singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
          schema_version INTEGER NOT NULL,
          minimum_app_schema_version INTEGER NOT NULL
        )`;
        yield* sql`INSERT INTO compadre_t3_migrations (migration_id, name)
          VALUES (${futureVersion}, 'additive_future_fixture')`;
        yield* sql`INSERT INTO compadre_t3_schema_compatibility
          VALUES (1, ${futureVersion}, ${POSTGRES_SCHEMA_VERSION})
          ON CONFLICT(singleton_id) DO UPDATE SET schema_version = excluded.schema_version, minimum_app_schema_version = excluded.minimum_app_schema_version`;
      }),
    );
    return sql;
  });

  const startApplication = Effect.gen(function* () {
    const backend = yield* PersistenceBackend;
    return backend.kind;
  }).pipe(Effect.provide(makePostgresPersistenceLive(url!)));

  it.effect(
    "restarts the older application on a newer additive schema and retains existing data",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at
      ) VALUES (
        'rollback-existing-project', 'Existing conversation project', '/tmp/rollback', '[]',
        '2026-09-09T12:00:00.000Z', '2026-09-09T12:00:00.000Z'
      )`;
        yield* installFutureSchema;
        // Render runs the rollback binary's migration command before application startup.
        expect(yield* runPostgresMigrations).toEqual([]);
        // Build a fresh application's actual persistence layer after the future migration commits.
        yield* Effect.gen(function* () {
          expect((yield* PersistenceBackend).kind).toBe("postgres");
          const restartedSql = yield* SqlClient.SqlClient;
          const before = yield* restartedSql<{ readonly title: string }>`
          SELECT title FROM projection_projects WHERE project_id = 'rollback-existing-project'
        `;
          expect(before[0]?.title).toBe("Existing conversation project");
          yield* restartedSql`UPDATE projection_projects SET title = 'Written after application rollback'
          WHERE project_id = 'rollback-existing-project'`;
        }).pipe(Effect.provide(makePostgresPersistenceLive(url!)));
        const after = yield* sql<{ readonly title: string }>`
        SELECT title FROM projection_projects WHERE project_id = 'rollback-existing-project'
      `;
        expect(after[0]?.title).toBe("Written after application rollback");
        const versions = yield* sql<{ readonly version: number }>`
        SELECT MAX(migration_id) AS version FROM compadre_t3_migrations
      `;
        expect(versions[0]?.version).toBe(futureVersion);
      }).pipe(Effect.scoped, Effect.provide(persistence())),
  );

  it.effect("refuses rollback below the schema's minimum application version", () =>
    Effect.gen(function* () {
      const sql = yield* installFutureSchema;
      yield* sql`UPDATE compadre_t3_schema_compatibility
        SET minimum_app_schema_version = ${futureVersion}`;
      expect(Exit.isFailure(yield* Effect.exit(startApplication))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(persistence())),
  );

  it.effect("refuses a future migration that failed to update the compatibility declaration", () =>
    Effect.gen(function* () {
      const sql = yield* installFutureSchema;
      yield* sql`UPDATE compadre_t3_schema_compatibility SET schema_version = ${POSTGRES_SCHEMA_VERSION}`;
      expect(Exit.isFailure(yield* Effect.exit(startApplication))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(persistence())),
  );

  it.effect("refuses a newer schema without a declaration or with an empty declaration table", () =>
    Effect.gen(function* () {
      const sql = yield* installFutureSchema;
      yield* sql`DELETE FROM compadre_t3_schema_compatibility`;
      expect(Exit.isFailure(yield* Effect.exit(startApplication))).toBe(true);
      yield* sql`DROP TABLE compadre_t3_schema_compatibility`;
      expect(Exit.isFailure(yield* Effect.exit(startApplication))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(persistence())),
  );
});
