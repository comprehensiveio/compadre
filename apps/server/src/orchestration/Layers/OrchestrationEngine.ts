import type {
  OrchestrationClientOrigin,
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { OrchestrationCommand } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  metricAttributes,
  orchestrationCommandAckDuration,
  orchestrationCommandsTotal,
  orchestrationCommandDuration,
} from "../../observability/Metrics.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { PersistenceBackend } from "../../persistence/Services/PersistenceBackend.ts";
import type { PersistenceLockKey } from "../../persistence/Services/PersistenceBackend.ts";
import {
  OrchestrationCommandIdConflictError,
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
  type OrchestrationProjectorDecodeError,
} from "../Errors.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
const isOrchestrationCommandPreviouslyRejectedError = Schema.is(
  OrchestrationCommandPreviouslyRejectedError,
);
const isOrchestrationCommandIdConflictError = Schema.is(OrchestrationCommandIdConflictError);
const isOrchestrationCommandInvariantError = Schema.is(OrchestrationCommandInvariantError);
const POSTGRES_EVENT_CHANNEL = "t3_orchestration_events";
const POSTGRES_COMMAND_WORKERS = 8;

interface CommandEnvelope {
  command: OrchestrationCommand;
  origin: OrchestrationClientOrigin | undefined;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
  startedAtMs: number;
}

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: ProjectId | ThreadId;
} {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.delete":
      return {
        aggregateKind: "project",
        aggregateId: command.projectId,
      };
    default:
      return {
        aggregateKind: "thread",
        aggregateId: command.threadId,
      };
  }
}

function commandToInitialLockKeys(
  command: OrchestrationCommand,
): ReadonlyArray<PersistenceLockKey> {
  const aggregate = commandToAggregateRef(command);
  const keys: PersistenceLockKey[] = [
    { scope: "command", key: command.commandId },
    { scope: aggregate.aggregateKind, key: aggregate.aggregateId },
  ];

  if (command.type === "thread.create") {
    keys.push({ scope: "project", key: command.projectId });
  }
  if (command.type === "project.create") {
    keys.push({ scope: "workspace", key: command.workspaceRoot });
  }
  if (command.type === "project.meta.update" && command.workspaceRoot !== undefined) {
    keys.push({ scope: "workspace", key: command.workspaceRoot });
  }

  return [...new Map(keys.map((key) => [`${key.scope}\0${key.key}`, key])).values()].toSorted(
    (left, right) => left.scope.localeCompare(right.scope) || left.key.localeCompare(right.key),
  );
}

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const persistenceBackend = yield* Effect.serviceOption(PersistenceBackend).pipe(
    Effect.map(
      Option.getOrElse((): PersistenceBackend["Service"] => ({
        kind: "sqlite" as const,
        lockOrchestrationKeys: () => Effect.void,
        lockOrchestrationCommitOrder: Effect.void,
      })),
    ),
  );
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  let commandReadModel = createEmptyReadModel(yield* nowIso);

  const commandQueue = yield* Queue.unbounded<CommandEnvelope>();
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();
  const publishedSequence = yield* Ref.make(0);
  const publishSemaphore = yield* Semaphore.make(1);

  const publishEvents = (events: ReadonlyArray<OrchestrationEvent>) => {
    if (persistenceBackend.kind === "sqlite") {
      // SQLite has one command worker, so it keeps the direct hot-stream
      // publication path used by local reactors.
      return Effect.gen(function* () {
        for (const event of events) {
          yield* PubSub.publish(eventPubSub, event);
        }
        const lastEvent = events.at(-1);
        if (lastEvent) yield* Ref.set(publishedSequence, lastEvent.sequence);
      });
    }
    const publish = Effect.gen(function* () {
      let cursor = yield* Ref.get(publishedSequence);
      for (const event of events) {
        if (event.sequence <= cursor) continue;
        yield* PubSub.publish(eventPubSub, event);
        cursor = event.sequence;
        yield* Ref.set(publishedSequence, cursor);
      }
    });
    return publishSemaphore.withPermits(1)(publish);
  };

  const publishPersistedEvents = publishSemaphore.withPermits(1)(
    Effect.gen(function* () {
      while (true) {
        const cursor = yield* Ref.get(publishedSequence);
        const events = yield* eventStore.readFromSequence(cursor, 256).pipe(Stream.runCollect);
        for (const event of events) {
          yield* PubSub.publish(eventPubSub, event);
          yield* Ref.set(publishedSequence, event.sequence);
        }
        if (events.length < 256) break;
      }
    }),
  );

  const projectEventsOntoReadModel = (
    baseReadModel: OrchestrationReadModel,
    events: ReadonlyArray<OrchestrationEvent>,
  ): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError, never> =>
    Effect.gen(function* () {
      let nextReadModel = baseReadModel;
      for (const event of events) {
        nextReadModel = yield* projectEvent(nextReadModel, event);
      }
      return nextReadModel;
    });

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> => {
    const dispatchStartSequence = commandReadModel.snapshotSequence;
    let processingStartedAtMs = 0;
    const aggregateRef = commandToAggregateRef(envelope.command);
    const baseMetricAttributes = {
      commandType: envelope.command.type,
      aggregateKind: aggregateRef.aggregateKind,
    } as const;
    const reconcileReadModelAfterDispatchFailure = Effect.gen(function* () {
      if (persistenceBackend.kind === "postgres") {
        yield* publishPersistedEvents;
        return;
      }
      const persistedEvents = yield* Stream.runCollect(
        eventStore.readFromSequence(dispatchStartSequence),
      ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)));
      if (persistedEvents.length === 0) {
        return;
      }

      commandReadModel = yield* projectEventsOntoReadModel(commandReadModel, persistedEvents);

      yield* publishEvents(persistedEvents);
    });

    return Effect.exit(
      Effect.gen(function* () {
        processingStartedAtMs = yield* Clock.currentTimeMillis;
        yield* Effect.annotateCurrentSpan({
          "orchestration.command_id": envelope.command.commandId,
          "orchestration.command_type": envelope.command.type,
          "orchestration.aggregate_kind": aggregateRef.aggregateKind,
          "orchestration.aggregate_id": aggregateRef.aggregateId,
        });

        const committedCommand = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              if (persistenceBackend.kind === "postgres") {
                yield* persistenceBackend.lockOrchestrationCommitOrder;
                yield* persistenceBackend.lockOrchestrationKeys(
                  commandToInitialLockKeys(envelope.command),
                );
              }

              const existingReceipt = yield* commandReceiptRepository.getByCommandId({
                commandId: envelope.command.commandId,
              });
              if (Option.isSome(existingReceipt)) {
                // A receipt only proves this exact command was handled. Replaying it
                // for a command aimed at another aggregate would report success for
                // work that never happened.
                if (
                  existingReceipt.value.aggregateKind !== aggregateRef.aggregateKind ||
                  existingReceipt.value.aggregateId !== aggregateRef.aggregateId
                ) {
                  return yield* new OrchestrationCommandIdConflictError({
                    commandId: envelope.command.commandId,
                    receiptAggregateKind: existingReceipt.value.aggregateKind,
                    receiptAggregateId: existingReceipt.value.aggregateId,
                    commandAggregateKind: aggregateRef.aggregateKind,
                    commandAggregateId: aggregateRef.aggregateId,
                  });
                }
                if (existingReceipt.value.status === "accepted") {
                  return {
                    _tag: "Existing" as const,
                    lastSequence: existingReceipt.value.resultSequence,
                  };
                }
                return yield* new OrchestrationCommandPreviouslyRejectedError({
                  commandId: envelope.command.commandId,
                  detail: existingReceipt.value.error ?? "Previously rejected.",
                });
              }

              // SQLite has one command worker and keeps this model current in
              // memory. Hosted PostgreSQL can have many server replicas, so it
              // reads the committed projection after it acquires the lock.
              let transactionReadModel =
                persistenceBackend.kind === "postgres"
                  ? yield* projectionSnapshotQuery.getCommandReadModel()
                  : commandReadModel;
              if (
                persistenceBackend.kind === "postgres" &&
                envelope.command.type === "project.delete"
              ) {
                const projectId = envelope.command.projectId;
                const childThreadLocks = transactionReadModel.threads
                  .filter((thread) => thread.projectId === projectId)
                  .map(
                    (thread): PersistenceLockKey => ({
                      scope: "thread",
                      key: thread.id,
                    }),
                  )
                  .toSorted((left, right) => left.key.localeCompare(right.key));
                yield* persistenceBackend.lockOrchestrationKeys(childThreadLocks);
                transactionReadModel = yield* projectionSnapshotQuery.getCommandReadModel();
              }
              const decision = yield* decideOrchestrationCommand({
                command: envelope.command,
                readModel: transactionReadModel,
              }).pipe(
                Effect.provideService(Crypto.Crypto, crypto),
                Effect.mapError((cause) =>
                  isOrchestrationCommandInvariantError(cause)
                    ? cause
                    : new OrchestrationCommandInvariantError({
                        commandType: envelope.command.type,
                        detail: "Failed to generate an event identifier.",
                        cause,
                      }),
                ),
                Effect.exit,
              );
              if (Exit.isFailure(decision)) {
                const error = Cause.squash(decision.cause);
                if (!isOrchestrationCommandInvariantError(error))
                  return yield* Effect.failCause(decision.cause);
                yield* commandReceiptRepository.upsert({
                  commandId: envelope.command.commandId,
                  aggregateKind: aggregateRef.aggregateKind,
                  aggregateId: aggregateRef.aggregateId,
                  acceptedAt: yield* nowIso,
                  resultSequence: transactionReadModel.snapshotSequence,
                  status: "rejected",
                  error: error.message,
                });
                return { _tag: "Rejected" as const, error };
              }
              const eventBase = decision.value;
              const plannedEvents = Array.isArray(eventBase) ? eventBase : [eventBase];
              const eventBases =
                envelope.origin === undefined
                  ? plannedEvents
                  : plannedEvents.map((planned) => ({
                      ...planned,
                      metadata: { ...planned.metadata, origin: envelope.origin },
                    }));
              const committedEvents: OrchestrationEvent[] = [];
              let nextCommandReadModel = transactionReadModel;

              for (const nextEvent of eventBases) {
                const savedEvent = yield* eventStore.append(nextEvent);
                nextCommandReadModel = yield* projectEvent(nextCommandReadModel, savedEvent);
                yield* projectionPipeline.projectEvent(savedEvent);
                committedEvents.push(savedEvent);
              }

              const lastSavedEvent = committedEvents.at(-1) ?? null;
              if (lastSavedEvent === null) {
                return yield* new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Command produced no events.",
                });
              }

              yield* commandReceiptRepository.upsert({
                commandId: envelope.command.commandId,
                aggregateKind: lastSavedEvent.aggregateKind,
                aggregateId: lastSavedEvent.aggregateId,
                acceptedAt: lastSavedEvent.occurredAt,
                resultSequence: lastSavedEvent.sequence,
                status: "accepted",
                error: null,
              });

              return {
                _tag: "Committed" as const,
                committedEvents,
                lastSequence: lastSavedEvent.sequence,
                nextCommandReadModel,
              } as const;
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (sqlError) =>
              Effect.fail(
                toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(sqlError),
              ),
            ),
          );

        if (committedCommand._tag === "Rejected") return yield* committedCommand.error;
        if (committedCommand._tag === "Existing") {
          return { sequence: committedCommand.lastSequence };
        }
        if (persistenceBackend.kind === "sqlite") {
          commandReadModel = committedCommand.nextCommandReadModel;
          yield* publishEvents(committedCommand.committedEvents);
        } else {
          // More than one PostgreSQL worker can finish at once. Reading from
          // the durable cursor prevents a later worker from publishing ahead
          // of an earlier committed event.
          yield* publishPersistedEvents.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to publish committed PostgreSQL events", { cause }),
            ),
          );
        }
        for (const [index, event] of committedCommand.committedEvents.entries()) {
          if (index === 0) {
            yield* Metric.update(
              Metric.withAttributes(
                orchestrationCommandAckDuration,
                metricAttributes({
                  ...baseMetricAttributes,
                  ackEventType: event.type,
                }),
              ),
              Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - envelope.startedAtMs)),
            );
          }
        }
        if (persistenceBackend.notify) {
          yield* persistenceBackend
            .notify(POSTGRES_EVENT_CHANNEL, String(committedCommand.lastSequence))
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("failed to notify PostgreSQL event listeners", { cause }),
              ),
            );
        }
        return { sequence: committedCommand.lastSequence };
      }).pipe(Effect.withSpan(`orchestration.command.${envelope.command.type}`)),
    ).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          const outcome = Exit.isSuccess(exit)
            ? "success"
            : Cause.hasInterruptsOnly(exit.cause)
              ? "interrupt"
              : "failure";
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandDuration,
              metricAttributes(baseMetricAttributes),
            ),
            Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - processingStartedAtMs)),
          );
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandsTotal,
              metricAttributes({
                ...baseMetricAttributes,
                outcome,
              }),
            ),
            1,
          );

          if (Exit.isSuccess(exit)) {
            yield* Deferred.succeed(envelope.result, exit.value);
            return;
          }

          const error = Cause.squash(exit.cause) as OrchestrationDispatchError;
          if (
            !isOrchestrationCommandPreviouslyRejectedError(error) &&
            !isOrchestrationCommandIdConflictError(error)
          ) {
            yield* reconcileReadModelAfterDispatchFailure.pipe(
              Effect.catch(() =>
                Effect.gen(function* () {
                  const snapshotSequence =
                    persistenceBackend.kind === "postgres"
                      ? yield* Ref.get(publishedSequence)
                      : commandReadModel.snapshotSequence;
                  yield* Effect.logWarning(
                    "failed to reconcile orchestration read model after dispatch failure",
                  ).pipe(
                    Effect.annotateLogs({
                      commandId: envelope.command.commandId,
                      snapshotSequence,
                    }),
                  );
                }),
              ),
            );
          }

          yield* Deferred.fail(envelope.result, error);
        }),
      ),
    );
  };

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* persistenceBackend.lockOrchestrationCommitOrder;
      yield* projectionPipeline.bootstrap;
    }),
  );
  commandReadModel = yield* projectionSnapshotQuery.getCommandReadModel();
  yield* Ref.set(publishedSequence, commandReadModel.snapshotSequence);

  if (persistenceBackend.listen) {
    const notificationListener = persistenceBackend.listen(POSTGRES_EVENT_CHANNEL).pipe(
      Stream.runForEach(() => publishPersistedEvents),
      Effect.retry(
        Schedule.exponential("100 millis").pipe(
          Schedule.modifyDelay(({ duration }) =>
            Effect.succeed(Duration.min(duration, Duration.seconds(5))),
          ),
        ),
      ),
      Effect.catchCause((cause) => Effect.logError("PostgreSQL event listener stopped", { cause })),
    );
    const replayFallback = publishPersistedEvents.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("PostgreSQL event replay fallback failed", { cause }),
      ),
      Effect.repeat(Schedule.spaced("1 second")),
    );
    yield* Effect.forkScoped(notificationListener);
    yield* Effect.forkScoped(replayFallback);
    yield* publishPersistedEvents;
  }

  const worker = Effect.forever(Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope)));
  const workerCount = persistenceBackend.kind === "postgres" ? POSTGRES_COMMAND_WORKERS : 1;
  yield* Effect.forEach(Array.from({ length: workerCount }), () => Effect.forkScoped(worker), {
    concurrency: 1,
    discard: true,
  });
  yield* Effect.logDebug("orchestration engine started").pipe(
    Effect.annotateLogs({ sequence: commandReadModel.snapshotSequence }),
  );

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive, limit) =>
    eventStore.readFromSequence(fromSequenceExclusive, limit);

  const dispatch: OrchestrationEngineShape["dispatch"] = (command, options) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      yield* Queue.offer(commandQueue, {
        command,
        origin: options?.origin,
        result,
        startedAtMs: yield* Clock.currentTimeMillis,
      });
      return yield* Deferred.await(result);
    });

  return {
    readEvents,
    dispatch,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events.
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return Stream.fromPubSub(eventPubSub);
    },
    // The local publication cursor advances only over committed durable events.
    latestSequence: Ref.get(publishedSequence),
  } satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
);
