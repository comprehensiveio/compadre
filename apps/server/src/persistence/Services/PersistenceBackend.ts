import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";
import type { SqlError } from "effect/unstable/sql/SqlError";

export type PersistenceBackendKind = "sqlite" | "postgres";

export interface PersistenceLockKey {
  readonly scope: string;
  readonly key: string;
}

export class PersistenceBackend extends Context.Service<
  PersistenceBackend,
  {
    readonly kind: PersistenceBackendKind;
    readonly lockOrchestrationKeys: (
      keys: ReadonlyArray<PersistenceLockKey>,
    ) => Effect.Effect<void, SqlError>;
    readonly lockOrchestrationCommitOrder: Effect.Effect<void, SqlError>;
    readonly listen?: (channel: string) => Stream.Stream<string, SqlError>;
    readonly notify?: (channel: string, payload: string) => Effect.Effect<void, SqlError>;
  }
>()("t3/persistence/Services/PersistenceBackend") {}

export const sqlite = Layer.succeed(PersistenceBackend, {
  kind: "sqlite",
  lockOrchestrationKeys: () => Effect.void,
  lockOrchestrationCommitOrder: Effect.void,
});

export class PersistenceReadClient extends Context.Service<
  PersistenceReadClient,
  import("effect/unstable/sql/SqlClient").SqlClient
>()("t3/persistence/Services/PersistenceBackend/PersistenceReadClient") {}
