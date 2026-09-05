import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  makePostgresClientLive,
  makePostgresPersistenceLive,
  runPostgresMigrations,
} from "./Layers/Postgres.ts";

/** Destructive integration fixtures are permitted only in a disposable local test database. */
export const makeTestPostgresPersistence = (url: string) => {
  const parsed = new URL(url);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
    !parsed.pathname.endsWith("_test")
  ) {
    throw new Error("PostgreSQL tests require a loopback database ending in _test.");
  }
  return Layer.unwrap(
    runPostgresMigrations.pipe(
      Effect.provide(makePostgresClientLive(url)),
      Effect.as(makePostgresPersistenceLive(url)),
    ),
  );
};
