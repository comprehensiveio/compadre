import * as Schema from "effect/Schema";

const OptionalString = Schema.optionalKey(Schema.String);
const OptionalNumber = Schema.optionalKey(Schema.Number);

export const CompadreThreadHealth = Schema.Literals(["healthy", "attention", "stuck"]);
export type CompadreThreadHealth = typeof CompadreThreadHealth.Type;

export const CompadreContainerStatus = Schema.Literals([
  "running",
  "stopped",
  "transitioning",
  "unknown",
]);
export type CompadreContainerStatus = typeof CompadreContainerStatus.Type;

export const CompadreThreadOperationsSnapshot = Schema.Struct({
  generatedAt: Schema.String,
  thresholds: Schema.Struct({
    attentionAfterMs: Schema.Number,
    stuckAfterMs: Schema.Number,
  }),
  counts: Schema.Struct({
    total: Schema.Number,
    working: Schema.Number,
    attention: Schema.Number,
    stuck: Schema.Number,
    containersRunning: Schema.Number,
  }),
  threads: Schema.Array(
    Schema.Struct({
      canonicalThreadId: Schema.String,
      providerInstanceId: Schema.String,
      workerThreadId: Schema.String,
      title: Schema.String,
      modelSelection: Schema.Struct({
        instanceId: Schema.String,
        model: Schema.String,
        options: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              id: Schema.String,
              value: Schema.Union([Schema.String, Schema.Boolean]),
            }),
          ),
        ),
      }),
      status: Schema.Literals(["working", "ready", "interrupted", "error", "unavailable"]),
      phase: Schema.String,
      health: CompadreThreadHealth,
      healthReason: Schema.String,
      createdAt: Schema.String,
      updatedAt: Schema.String,
      lastActiveAt: OptionalString,
      environment: Schema.optionalKey(
        Schema.Struct({
          container: Schema.Literals(["running", "stopped", "unknown"]),
          devServer: Schema.Literals(["ready", "stopped", "unresponsive", "unknown"]),
          database: Schema.Literals(["ready", "stopped", "unknown"]),
          checkedAt: OptionalString,
          previewUrl: OptionalString,
        }),
      ),
      activitySince: OptionalString,
      recentEvents: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            id: OptionalString,
            type: Schema.String,
            at: OptionalString,
            detail: OptionalString,
          }),
        ),
      ),
      container: Schema.Struct({
        status: CompadreContainerStatus,
        workerState: Schema.optionalKey(
          Schema.Literals(["running", "warm", "hibernating", "suspended", "restoring"]),
        ),
        sandboxId: Schema.String,
        generation: Schema.Number,
        startedAt: OptionalString,
        warmUntil: OptionalString,
        hasSnapshot: Schema.optionalKey(Schema.Boolean),
      }),
      activeRun: Schema.optionalKey(
        Schema.Struct({
          runId: Schema.String,
          status: Schema.Literals([
            "running",
            "interrupted",
            "completed",
            "failed",
            "aborted",
            "missing",
          ]),
          startedAt: OptionalString,
          finishedAt: OptionalString,
          driverEpoch: OptionalNumber,
          idleMs: OptionalNumber,
          lastEvent: Schema.optionalKey(
            Schema.Struct({
              type: Schema.String,
              at: OptionalString,
              detail: OptionalString,
            }),
          ),
        }),
      ),
    }),
  ),
});
export type CompadreThreadOperationsSnapshot = typeof CompadreThreadOperationsSnapshot.Type;
export type CompadreThreadOperation = CompadreThreadOperationsSnapshot["threads"][number];
