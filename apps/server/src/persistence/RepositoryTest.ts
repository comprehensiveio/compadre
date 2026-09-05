import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CENTRAL_SQLITE_TABLES } from "./CompadreSqliteImport.ts";
import { makeTestPostgresPersistence } from "./PostgresTest.ts";
import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";

const url = process.env.COMPADRE_T3_REPOSITORY_TEST_URL;
export const RepositoryTestPersistence = url
  ? Layer.effectDiscard(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const table of CENTRAL_SQLITE_TABLES)
          yield* sql`TRUNCATE TABLE ${sql(table)} RESTART IDENTITY`;
      }),
    ).pipe(Layer.provideMerge(makeTestPostgresPersistence(url)))
  : SqlitePersistenceMemory;
