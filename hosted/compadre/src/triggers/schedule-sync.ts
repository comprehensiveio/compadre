import {
  ScheduleAlreadyRunning,
  ScheduleNotFoundError,
  ScheduleOverlapPolicy,
  type ScheduleOptions,
} from "@temporalio/client";
import { log, serializeError } from "../logging.js";
import { getTemporalClient } from "../temporal/client.js";
import { NATIVE_T3_TASK_QUEUE } from "../temporal/shared.js";
import { triggeredPromptScheduleId, type TriggeredPromptRecord } from "./types.js";
import type { TriggeredPromptStoreApi } from "./store.js";

/**
 * Postgres is the source of truth for triggered prompts; each row is mirrored
 * to one Temporal Schedule that fires triggeredPromptWorkflow with just the
 * trigger id (the workflow re-reads the row so edits apply without resync).
 */

function scheduleSpecOf(record: TriggeredPromptRecord): ScheduleOptions["spec"] {
  return {
    cronExpressions: [record.triggerConfig.cronExpression],
    ...(record.triggerConfig.timezone
      ? { timezone: record.triggerConfig.timezone }
      : {}),
  };
}

export async function syncTriggerSchedule(
  record: TriggeredPromptRecord,
): Promise<void> {
  const client = await getTemporalClient();
  const scheduleId = triggeredPromptScheduleId(record.id);
  const spec = scheduleSpecOf(record);
  const options: ScheduleOptions = {
    scheduleId,
    spec,
    action: {
      type: "startWorkflow",
      workflowType: "triggeredPromptWorkflow",
      taskQueue: NATIVE_T3_TASK_QUEUE,
      args: [{ triggerId: record.id }],
    },
    policies: { overlap: ScheduleOverlapPolicy.SKIP },
    state: { paused: !record.enabled, note: record.name },
  };

  try {
    await client.schedule.create(options);
    log.info(
      { scheduleId, cron: record.triggerConfig.cronExpression },
      "triggered prompt schedule created",
    );
  } catch (error) {
    if (!(error instanceof ScheduleAlreadyRunning)) throw error;
    await client.schedule.getHandle(scheduleId).update((previous) => ({
      ...previous,
      spec,
      state: { ...previous.state, paused: !record.enabled, note: record.name },
    }));
    log.info(
      { scheduleId, cron: record.triggerConfig.cronExpression },
      "triggered prompt schedule updated",
    );
  }
}

export async function deleteTriggerSchedule(triggerId: string): Promise<void> {
  const client = await getTemporalClient();
  const scheduleId = triggeredPromptScheduleId(triggerId);
  try {
    await client.schedule.getHandle(scheduleId).delete();
    log.info({ scheduleId }, "triggered prompt schedule deleted");
  } catch (error) {
    if (!(error instanceof ScheduleNotFoundError)) throw error;
  }
}

/** Fire a trigger immediately through its schedule's exact workflow path. */
export async function runTriggerNow(triggerId: string): Promise<string> {
  const client = await getTemporalClient();
  const workflowId = `triggered-prompt-manual-${triggerId}-${Date.now()}`;
  await client.workflow.start("triggeredPromptWorkflow", {
    taskQueue: NATIVE_T3_TASK_QUEUE,
    workflowId,
    args: [{ triggerId }],
  });
  return workflowId;
}

/**
 * Startup reconciliation: make every DB row's schedule exist and match, and
 * remove schedules whose rows are gone. Failures are logged, never fatal —
 * the next boot retries.
 */
export async function ensureTriggeredPromptSchedules(
  store: TriggeredPromptStoreApi,
): Promise<void> {
  const records = await store.list();
  const knownIds = new Set(
    records.map((record) => triggeredPromptScheduleId(record.id)),
  );

  for (const record of records) {
    try {
      await syncTriggerSchedule(record);
    } catch (error) {
      log.warn(
        { triggerId: record.id, ...serializeError(error) },
        "failed to sync triggered prompt schedule",
      );
    }
  }

  try {
    const client = await getTemporalClient();
    for await (const schedule of client.schedule.list()) {
      if (!schedule.scheduleId.startsWith("triggered-prompt-")) continue;
      if (knownIds.has(schedule.scheduleId)) continue;
      await client.schedule.getHandle(schedule.scheduleId).delete();
      log.info(
        { scheduleId: schedule.scheduleId },
        "deleted orphaned triggered prompt schedule",
      );
    }
  } catch (error) {
    log.warn(
      serializeError(error),
      "failed to prune orphaned triggered prompt schedules",
    );
  }
}
