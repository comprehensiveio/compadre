import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";

export const migratePostgresCommand = Command.make("migrate-postgres").pipe(
  Command.withDescription("Apply the ordered central-server PostgreSQL migrations."),
  Command.withHandler(() => {
    const url = process.env.COMPADRE_T3_POSTGRES_URL?.trim();
    if (!url) {
      return Effect.die(new Error("COMPADRE_T3_POSTGRES_URL is required to run migrations."));
    }
    return Effect.promise(() => import("../persistence/Layers/Postgres.ts")).pipe(
      Effect.flatMap(({ makePostgresClientLive, runPostgresMigrations }) =>
        runPostgresMigrations.pipe(
          Effect.tap((migrations) =>
            Effect.logInfo("Central-server PostgreSQL migrations complete", {
              applied: migrations.length,
            }),
          ),
          Effect.provide(makePostgresClientLive(url)),
        ),
      ),
    );
  }),
);
