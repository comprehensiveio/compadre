/**
 * Native T3 run workflow.
 *
 * Runs inside Temporal's isolated workflow VM: the only runtime import
 * allowed here is @temporalio/workflow, and all state beyond the tiny input
 * lives in Compadre Postgres, loaded by the activities. Every behavior change
 * to this file must keep already-running histories replayable — gate changes
 * with patched() once production workflows exist.
 */
import {
  ActivityCancellationType,
  CancellationScope,
  isCancellation,
  log,
  patched,
  proxyActivities,
} from "@temporalio/workflow";
import type * as activities from "./activities.js";
import type {
  NativeT3RunWorkflowInput,
  NativeT3RunWorkflowResult,
  PreviewActivationWorkflowInput,
} from "./shared.js";
import type { TriggeredPromptWorkflowInput } from "../triggers/types.js";

// Retained only so pre-fix workflow histories replay deterministically.
// Its 25-minute ceiling killed legitimately long turns; see the patched()
// selection inside the workflow. Remove after those histories drain
// (retention is 7 days from 2026-09-01).
const { driveNativeT3RunActivity: driveWithLegacyCeiling } = proxyActivities<
  typeof activities
>({
  startToCloseTimeout: "25 minutes",
  heartbeatTimeout: "2 minutes",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
    maximumAttempts: 3,
    nonRetryableErrorTypes: ["NativeT3RunStateError"],
  },
});

const { driveNativeT3RunActivity } = proxyActivities<typeof activities>({
  // One attempt may legitimately watch for the worker's full ~2-hour Modal
  // lifetime: the gateway's terminal wait is progress-aware (20-minute
  // no-durable-progress inactivity limit, absolute ceiling derived from the
  // sandbox's remaining lifetime). The 2-minute heartbeat timeout still
  // detects a dead controller quickly, and retries resume projection from
  // the durable event log without duplicating output.
  startToCloseTimeout: "130 minutes",
  heartbeatTimeout: "2 minutes",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
    maximumAttempts: 3,
    nonRetryableErrorTypes: ["NativeT3RunStateError"],
  },
});

const { finalizeNativeT3RunActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: {
    initialInterval: "1 second",
    backoffCoefficient: 2,
    maximumAttempts: 5,
  },
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});

export async function nativeT3RunWorkflow(
  input: NativeT3RunWorkflowInput,
): Promise<NativeT3RunWorkflowResult> {
  try {
    const outcome = patched("drive-worker-lifetime-ceiling-v1")
      ? await driveNativeT3RunActivity(input)
      : await driveWithLegacyCeiling(input);
    return { status: outcome.status };
  } catch (error) {
    const cancelled = isCancellation(error);
    const message = cancelled
      ? "The native T3 run was cancelled."
      : error instanceof Error
        ? error.message
        : String(error);
    // The run record and event log must converge to a terminal state even
    // while this workflow is itself being cancelled.
    await CancellationScope.nonCancellable(() =>
      finalizeNativeT3RunActivity({
        runId: input.runId,
        cancelled,
        message,
      }),
    );
    throw error;
  }
}

const { buildT3WorkerTemplateActivity } = proxyActivities<typeof activities>({
  // A build is a full cold provision (clone, dependency restore, production
  // backup download and restore) plus a snapshot: ~15 minutes measured.
  startToCloseTimeout: "45 minutes",
  heartbeatTimeout: "2 minutes",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: {
    initialInterval: "1 minute",
    backoffCoefficient: 2,
    maximumAttempts: 2,
  },
});

/**
 * Cron workflow (see ensureWorkerTemplateBuildSchedule): each firing builds
 * one fresh golden worker template and publishes its snapshot ID. Failures
 * leave the previous template serving and surface in Temporal's UI.
 */
export async function t3WorkerTemplateBuildWorkflow(): Promise<void> {
  await buildT3WorkerTemplateActivity();
}

const { activatePreviewActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: "20 minutes",
  heartbeatTimeout: "2 minutes",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
    maximumAttempts: 3,
    nonRetryableErrorTypes: ["PreviewActivationStateError"],
  },
});

const { recordPreviewActivationFailureActivity } = proxyActivities<
  typeof activities
>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5 },
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});

export async function previewActivationWorkflow(
  input: PreviewActivationWorkflowInput,
): Promise<void> {
  try {
    await activatePreviewActivity(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await CancellationScope.nonCancellable(() =>
      recordPreviewActivationFailureActivity({ ...input, message }),
    );
    throw error;
  }
}

const { loadTriggeredPromptActivity, recordTriggerFiredActivity } =
  proxyActivities<typeof activities>({
    startToCloseTimeout: "1 minute",
    retry: { maximumAttempts: 3 },
  });

// Delivery posts to Slack and dispatches central turns; a blind retry could
// double-post, so it gets a single attempt and the schedule's next fire acts
// as the retry.
const { deliverTriggeredPromptActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 1 },
});

/**
 * Fired by a Temporal Schedule (one per triggered prompt). Re-reads the
 * definition from Postgres so edits take effect without resyncing the
 * schedule, then hands the prompt to the delivery layer.
 */
export async function triggeredPromptWorkflow(
  input: TriggeredPromptWorkflowInput,
): Promise<void> {
  const record = await loadTriggeredPromptActivity(input.triggerId);
  if (!record) {
    log.warn("Triggered prompt not found; skipping fire", {
      triggerId: input.triggerId,
    });
    return;
  }
  if (!record.enabled) {
    log.info("Triggered prompt disabled; skipping fire", {
      triggerId: input.triggerId,
    });
    return;
  }
  const result = await deliverTriggeredPromptActivity(record);
  await recordTriggerFiredActivity(input.triggerId, result);
}
