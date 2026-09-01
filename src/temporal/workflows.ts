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
  patched,
  proxyActivities,
} from "@temporalio/workflow";
import type * as activities from "./activities.js";
import type {
  NativeT3RunWorkflowInput,
  NativeT3RunWorkflowResult,
} from "./shared.js";

// Retained only so pre-fix workflow histories replay deterministically.
// Its 25-minute ceiling killed legitimately long turns; see the patched()
// selection inside the workflow. Remove after those histories drain
// (retention is 7 days from 2026-09-01).
const { driveNativeT3RunActivity: driveWithLegacyCeiling } =
  proxyActivities<typeof activities>({
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
