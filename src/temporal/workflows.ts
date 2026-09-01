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
  proxyActivities,
} from "@temporalio/workflow";
import type * as activities from "./activities.js";
import type {
  NativeT3RunWorkflowInput,
  NativeT3RunWorkflowResult,
} from "./shared.js";

const { driveNativeT3RunActivity } = proxyActivities<typeof activities>({
  // One watch attempt covers the 20-minute terminal wait plus dispatch and
  // worker provisioning headroom. Retries resume projection from the durable
  // event log, so attempts never duplicate already-persisted output.
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
    const outcome = await driveNativeT3RunActivity(input);
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
