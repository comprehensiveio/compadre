import * as TestClock from "effect/testing/TestClock";
import { PersistenceBackend } from "../../persistence/Services/PersistenceBackend.ts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type OrchestrationEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { makeTestPostgresPersistence } from "../../persistence/PostgresTest.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const postgresUrl = process.env.COMPADRE_T3_POSTGRES_TEST_URL;
const createdAt = "2026-09-03T12:00:00.000Z";
const loadWriteCount = Number.parseInt(process.env.COMPADRE_T3_POSTGRES_LOAD_WRITES ?? "300", 10);

const makeSystem = (missNotifications = false) =>
  Effect.gen(function* () {
    const base = makeTestPostgresPersistence(postgresUrl!);
    const PersistenceLive = missNotifications
      ? Layer.effect(
          PersistenceBackend,
          Effect.gen(function* () {
            const backend = yield* PersistenceBackend;
            return { ...backend, listen: () => Stream.never, notify: () => Effect.void };
          }),
        ).pipe(Layer.provideMerge(base))
      : base;
    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "compadre-postgres-engine-test-",
    });
    const layer = Layer.mergeAll(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationProjectionPipelineLive),
      ),
      OrchestrationProjectionSnapshotQueryLive,
    ).pipe(
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(PersistenceLive),
      Layer.provideMerge(ServerConfigLayer),
      Layer.provideMerge(NodeServices.layer),
    );
    const scope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const context = yield* Layer.buildWithScope(layer, scope);
    const services = yield* Effect.gen(function* () {
      return {
        engine: yield* OrchestrationEngineService,
        snapshots: yield* ProjectionSnapshotQuery,
      };
    }).pipe(Effect.provide(context));
    return {
      ...services,
      close: Scope.close(scope, Exit.void),
    };
  });

const resetDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    TRUNCATE TABLE
      orchestration_command_receipts,
      orchestration_events,
      projection_pending_approvals,
      projection_thread_activities,
      projection_thread_messages,
      projection_thread_proposed_plans,
      projection_thread_sessions,
      projection_threads,
      projection_turns,
      projection_projects,
      projection_state
    RESTART IDENTITY
  `;
});

const resetProjections = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    TRUNCATE TABLE
      projection_pending_approvals,
      projection_thread_activities,
      projection_thread_messages,
      projection_thread_proposed_plans,
      projection_thread_sessions,
      projection_threads,
      projection_turns,
      projection_projects,
      projection_state
    RESTART IDENTITY
  `;
});

describe.runIf(postgresUrl)("PostgreSQL orchestration engine", () => {
  it.effect("persists events, receipts, and projections through restart", () =>
    Effect.gen(function* () {
      const persistence = makeTestPostgresPersistence(postgresUrl!);
      yield* resetDatabase.pipe(Effect.provide(persistence), Effect.scoped);

      const first = yield* makeSystem();
      yield* first.engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("postgres-project-create"),
        projectId: ProjectId.make("postgres-project"),
        title: "PostgreSQL project",
        workspaceRoot: "/tmp/postgres-project",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      });
      yield* first.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("postgres-thread-create"),
        threadId: ThreadId.make("postgres-thread"),
        projectId: ProjectId.make("postgres-project"),
        title: "PostgreSQL thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      yield* first.engine.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("postgres-thread-snooze"),
        threadId: ThreadId.make("postgres-thread"),
        snoozedUntil: "2026-09-04T12:00:00.000Z",
      });
      yield* first.close;

      yield* resetProjections.pipe(Effect.provide(persistence), Effect.scoped);

      const second = yield* makeSystem();
      const snapshot = yield* second.snapshots.getSnapshot();
      expect(snapshot.snapshotSequence).toBe(3);
      expect(snapshot.projects.map((project) => project.id)).toEqual(["postgres-project"]);
      expect(snapshot.threads).toHaveLength(1);
      expect(snapshot.threads[0]?.snoozedUntil).toBe("2026-09-04T12:00:00.000Z");

      const duplicate = yield* second.engine.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("postgres-thread-snooze"),
        threadId: ThreadId.make("postgres-thread"),
        snoozedUntil: "2026-09-04T12:00:00.000Z",
      });
      expect(duplicate.sequence).toBe(3);
      yield* second.close;
    }).pipe(Effect.scoped),
  );

  it.effect("serializes commands from two server replicas against current state", () =>
    Effect.gen(function* () {
      const persistence = makeTestPostgresPersistence(postgresUrl!);
      yield* resetDatabase.pipe(Effect.provide(persistence), Effect.scoped);

      const first = yield* makeSystem();
      yield* first.engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("replica-project-create"),
        projectId: ProjectId.make("replica-project"),
        title: "Replica project",
        workspaceRoot: "/tmp/replica-project",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      });
      yield* first.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("replica-thread-create"),
        threadId: ThreadId.make("replica-thread"),
        projectId: ProjectId.make("replica-project"),
        title: "Replica thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      });

      const second = yield* makeSystem(true);
      const crossReplicaEvent = yield* second.engine.streamDomainEvents.pipe(
        Stream.filter((event) => event.commandId === "replica-thread-snooze"),
        Stream.runHead,
        Effect.forkScoped,
      );
      yield* first.engine.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("replica-thread-snooze"),
        threadId: ThreadId.make("replica-thread"),
        snoozedUntil: "2026-09-04T12:00:00.000Z",
      });
      yield* TestClock.adjust("1 second");
      const received = yield* Fiber.join(crossReplicaEvent);
      expect(received._tag).toBe("Some");
      if (received._tag === "Some") {
        expect(received.value.type).toBe("thread.snoozed");
      }
      yield* second.engine.dispatch({
        type: "thread.pin",
        commandId: CommandId.make("replica-thread-pin"),
        threadId: ThreadId.make("replica-thread"),
      });

      const snapshot = yield* first.snapshots.getSnapshot();
      expect(snapshot.threads[0]?.pinnedAt).not.toBeNull();
      expect(snapshot.threads[0]?.snoozedUntil).toBeNull();

      const duplicateCommand = {
        type: "thread.meta.update" as const,
        commandId: CommandId.make("replica-duplicate-command"),
        threadId: ThreadId.make("replica-thread"),
        title: "One update",
      };
      const [left, right] = yield* Effect.all(
        [first.engine.dispatch(duplicateCommand), second.engine.dispatch(duplicateCommand)],
        { concurrency: "unbounded" },
      );
      expect(left.sequence).toBe(right.sequence);
      const conflicting = yield* second.engine
        .dispatch({ ...duplicateCommand, threadId: ThreadId.make("other-thread") })
        .pipe(Effect.exit);
      expect(Exit.isFailure(conflicting)).toBe(true);

      const events = yield* first.engine.readEvents(0, 100).pipe(
        Stream.runCollect,
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      );
      expect(
        events.filter((event) => event.commandId === "replica-duplicate-command"),
      ).toHaveLength(1);
      expect(events.map((event) => event.type)).toContain("thread.unsnoozed");

      yield* Effect.all([first.close, second.close], { concurrency: "unbounded" });
    }).pipe(Effect.scoped),
  );

  it.effect("keeps one active project for a workspace across two replicas", () =>
    Effect.gen(function* () {
      const persistence = makeTestPostgresPersistence(postgresUrl!);
      yield* resetDatabase.pipe(Effect.provide(persistence), Effect.scoped);

      const first = yield* makeSystem();
      const second = yield* makeSystem();
      const [left, right] = yield* Effect.all(
        [
          first.engine
            .dispatch({
              type: "project.create",
              commandId: CommandId.make("workspace-project-left-create"),
              projectId: ProjectId.make("workspace-project-left"),
              title: "Workspace project left",
              workspaceRoot: "/tmp/shared-workspace",
              defaultModelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5-codex",
              },
              createdAt,
            })
            .pipe(Effect.exit),
          second.engine
            .dispatch({
              type: "project.create",
              commandId: CommandId.make("workspace-project-right-create"),
              projectId: ProjectId.make("workspace-project-right"),
              title: "Workspace project right",
              workspaceRoot: "/tmp/shared-workspace",
              defaultModelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5-codex",
              },
              createdAt,
            })
            .pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      );

      expect([left, right].filter(Exit.isSuccess)).toHaveLength(1);
      expect([left, right].filter(Exit.isFailure)).toHaveLength(1);
      const snapshot = yield* first.snapshots.getSnapshot();
      expect(snapshot.projects).toHaveLength(1);
      expect(snapshot.projects[0]?.workspaceRoot).toBe("/tmp/shared-workspace");

      yield* Effect.all([first.close, second.close], { concurrency: "unbounded" });
    }).pipe(Effect.scoped),
  );

  it.effect(`handles ${loadWriteCount} writes while replicas serve concurrent shell reads`, () =>
    Effect.gen(function* () {
      const persistence = makeTestPostgresPersistence(postgresUrl!);
      yield* resetDatabase.pipe(Effect.provide(persistence), Effect.scoped);

      const first = yield* makeSystem();
      yield* first.engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("load-project-create"),
        projectId: ProjectId.make("load-project"),
        title: "Load project",
        workspaceRoot: "/tmp/load-project",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      });
      for (let index = 0; index < 10; index += 1) {
        yield* first.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`load-thread-${index}-create`),
          threadId: ThreadId.make(`load-thread-${index}`),
          projectId: ProjectId.make("load-project"),
          title: `Load thread ${index}`,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
      }

      const second = yield* makeSystem();
      const reads = Effect.all(
        Array.from({ length: 50 }, (_, index) =>
          (index % 2 === 0 ? first : second).snapshots.getShellSnapshot(),
        ),
        { concurrency: "unbounded" },
      );
      const writes = Effect.all(
        Array.from({ length: loadWriteCount }, (_, index) => {
          const system = index % 2 === 0 ? first : second;
          return system.engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make(`load-update-${index}`),
            threadId: ThreadId.make(`load-thread-${index % 10}`),
            title: `Load update ${index}`,
          });
        }),
        { concurrency: "unbounded" },
      );
      const [snapshots, results] = yield* Effect.all([reads, writes], { concurrency: "unbounded" });
      expect(snapshots).toHaveLength(50);
      expect(snapshots.every((snapshot) => snapshot.threads.length === 10)).toBe(true);
      expect(new Set(results.map((result) => result.sequence)).size).toBe(loadWriteCount);

      const events = yield* first.engine.readEvents(0, 11 + loadWriteCount).pipe(
        Stream.runCollect,
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      );
      expect(events).toHaveLength(11 + loadWriteCount);
      expect(events.map((event) => event.sequence)).toEqual(
        Array.from({ length: 11 + loadWriteCount }, (_, index) => index + 1),
      );
      const finalSnapshot = yield* first.snapshots.getSnapshot();
      for (const thread of finalSnapshot.threads) {
        const finalUpdate = events.findLast(
          (event) => event.type === "thread.meta-updated" && event.payload.threadId === thread.id,
        );
        expect(finalUpdate?.type).toBe("thread.meta-updated");
        if (finalUpdate?.type === "thread.meta-updated") {
          expect(thread.title).toBe(finalUpdate.payload.title);
        }
      }

      yield* Effect.all([first.close, second.close], { concurrency: "unbounded" });
    }).pipe(Effect.scoped),
  );
  it.effect("a receipt insert failure rolls back events, all projections, and cursors", () =>
    Effect.gen(function* () {
      const persistence = makeTestPostgresPersistence(postgresUrl!);
      yield* resetDatabase.pipe(Effect.provide(persistence), Effect.scoped);
      const system = yield* makeSystem();
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE OR REPLACE FUNCTION test_reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected receipt failure'; END $$`;
        yield* sql`CREATE TRIGGER test_reject_receipt BEFORE INSERT ON orchestration_command_receipts FOR EACH ROW EXECUTE FUNCTION test_reject_receipt()`;
      }).pipe(Effect.provide(persistence), Effect.scoped);
      const result = yield* system.engine
        .dispatch({
          type: "project.create",
          commandId: CommandId.make("rollback-command"),
          projectId: ProjectId.make("rollback-project"),
          title: "Rollback",
          workspaceRoot: "/tmp/rollback-command",
          defaultModelSelection: null,
          createdAt,
        })
        .pipe(Effect.exit);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DROP TRIGGER test_reject_receipt ON orchestration_command_receipts`;
        yield* sql`DROP FUNCTION test_reject_receipt()`;
        for (const table of [
          "orchestration_events",
          "orchestration_command_receipts",
          "projection_projects",
          "projection_state",
        ]) {
          const rows = yield* sql<{
            count: string;
          }>`SELECT COUNT(*)::text AS count FROM ${sql(table)}`;
          expect(rows[0]?.count).toBe("0");
        }
      }).pipe(Effect.provide(persistence), Effect.scoped);
      expect(Exit.isFailure(result)).toBe(true);
      yield* system.close;
    }).pipe(Effect.scoped),
  );
});
