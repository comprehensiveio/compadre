import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const POSTGRES_MIGRATION_LOCK_KEY = "compadre_t3_migrations";

type CompatibilityDeclaration = {
  readonly schemaVersion: number;
  readonly minimumAppSchemaVersion: number;
};

/** A newer schema is usable only when its migration explicitly permits this binary. */
export function schemaIncompatibility(
  applicationVersion: number,
  databaseVersion: number | null,
  declaration: CompatibilityDeclaration | null,
): string | undefined {
  if (!Number.isSafeInteger(databaseVersion) || databaseVersion === null || databaseVersion < 1) {
    return "Central PostgreSQL has no valid migration version; run migrate-postgres before serving.";
  }
  if (databaseVersion < applicationVersion) {
    return "Central PostgreSQL schema is older than this application; run migrate-postgres before serving.";
  }
  if (declaration === null) {
    return databaseVersion === applicationVersion
      ? undefined
      : "Central PostgreSQL schema is newer than this application and has no compatibility declaration; use a compatible application binary.";
  }
  if (
    declaration.schemaVersion !== databaseVersion ||
    !Number.isSafeInteger(declaration.minimumAppSchemaVersion) ||
    declaration.minimumAppSchemaVersion < 1 ||
    declaration.minimumAppSchemaVersion > databaseVersion
  ) {
    return "Central PostgreSQL schema compatibility declaration is invalid or stale; repair it through a reviewed migration.";
  }
  if (applicationVersion < declaration.minimumAppSchemaVersion) {
    return "Central PostgreSQL schema no longer supports this application; use a compatible application binary.";
  }
  return undefined;
}

/** Read version and compatibility atomically with respect to the explicit migration CLI. */
export const validatePostgresSchemaCompatibility = Effect.fn("validatePostgresSchemaCompatibility")(
  function* (applicationVersion: number) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${POSTGRES_MIGRATION_LOCK_KEY}, 0))`;
        const versions = yield* sql<{ readonly version: number | null }>`
        SELECT MAX(migration_id) AS version FROM compadre_t3_migrations
      `;
        const databaseVersion = versions[0]?.version ?? null;
        const tables = yield* sql<{ readonly exists: boolean }>`
        SELECT to_regclass('compadre_t3_schema_compatibility') IS NOT NULL AS exists
      `;
        let declaration: CompatibilityDeclaration | null = null;
        if (tables[0]?.exists) {
          const rows = yield* sql<CompatibilityDeclaration & { readonly singletonId: number }>`
          SELECT singleton_id AS "singletonId", schema_version AS "schemaVersion",
            minimum_app_schema_version AS "minimumAppSchemaVersion"
          FROM compadre_t3_schema_compatibility
        `;
          if (rows.length !== 1 || rows[0]?.singletonId !== 1) {
            return yield* Effect.die(
              new Error(
                "Central PostgreSQL requires exactly one schema compatibility declaration.",
              ),
            );
          }
          declaration = rows[0];
        }
        const reason = schemaIncompatibility(applicationVersion, databaseVersion, declaration);
        if (reason !== undefined) return yield* Effect.die(new Error(reason));
        if (databaseVersion !== applicationVersion) {
          yield* Effect.logInfo("Central PostgreSQL is using a compatible newer schema", {
            applicationSchemaVersion: applicationVersion,
            databaseSchemaVersion: databaseVersion,
            minimumAppSchemaVersion: declaration?.minimumAppSchemaVersion,
          });
        }
      }),
    );
  },
);
