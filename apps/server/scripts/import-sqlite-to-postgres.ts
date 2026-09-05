import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import { importSqliteSnapshot } from "../src/persistence/CompadreSqliteImport.ts";
import { makePostgresPersistenceLive } from "../src/persistence/Layers/Postgres.ts";

const [snapshot, digest] = process.argv.slice(2);
const url = process.env.COMPADRE_T3_POSTGRES_URL?.trim();
if (!snapshot || !digest || !url) {
  throw new Error(
    "Usage: COMPADRE_T3_POSTGRES_URL=<empty target> node dist/import-sqlite-to-postgres.mjs <snapshot.sqlite> <sha256>",
  );
}
importSqliteSnapshot(snapshot, digest).pipe(
  Effect.tap((report) => Effect.logInfo("Verified central T3 import", report)),
  Effect.provide(makePostgresPersistenceLive(url)),
  Effect.scoped,
  NodeRuntime.runMain,
);
