import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type PersistenceMode = "sqlite" | "postgres";

export function resolvePersistenceMode(
  environment: NodeJS.ProcessEnv = process.env,
): PersistenceMode {
  const configured = environment.COMPADRE_T3_PERSISTENCE?.trim().toLowerCase() || "auto";
  const hasPostgresUrl = (environment.COMPADRE_T3_POSTGRES_URL?.trim().length ?? 0) > 0;

  if (configured === "postgres") {
    if (!hasPostgresUrl) {
      throw new Error(
        "COMPADRE_T3_POSTGRES_URL is required when COMPADRE_T3_PERSISTENCE=postgres.",
      );
    }
    return "postgres";
  }
  if (configured === "sqlite") return "sqlite";
  if (configured === "auto") return hasPostgresUrl ? "postgres" : "sqlite";

  throw new Error("COMPADRE_T3_PERSISTENCE must be auto, sqlite, or postgres.");
}

export const usesPostgresPersistence = () => resolvePersistenceMode() === "postgres";

/** Deployment restriction until all provider side effects have durable ownership. */
export function assertSingleProcessReactors(environment: NodeJS.ProcessEnv = process.env): void {
  if (environment.COMPADRE_T3_REACTOR_MODE !== "single-process") {
    throw new Error(
      "PostgreSQL server requires COMPADRE_T3_REACTOR_MODE=single-process and a disk-backed Recreate deployment; overlapping reactors are not supported.",
    );
  }
}

export const layerConfig = Layer.unwrap(
  Effect.promise(async () => {
    if (usesPostgresPersistence()) {
      assertSingleProcessReactors();
      const postgres = await import("./Postgres.ts");
      const attachments = await import("../../assets/CompadreAttachmentObjects.ts");
      return attachments.layer.pipe(Layer.provideMerge(postgres.layerConfig), Layer.orDie);
    }
    const sqlite = await import("./Sqlite.ts");
    return sqlite.layerConfig.pipe(Layer.orDie);
  }),
);
