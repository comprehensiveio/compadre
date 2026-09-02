import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import {
  driveNativeT3Run,
  finalizeNativeT3Run,
  NativeT3RunStateError,
  type NativeT3RunOutcome,
} from "../t3/native-t3-run-driver.js";
import { getConfiguredThreadPersistence } from "../persistence/runtime.js";
import { getConfiguredNativeT3RunDriverDependencies } from "../t3/runtime.js";
import { buildT3WorkerTemplate } from "../t3/worker-templates.js";
import type { NativeT3RunWorkflowInput } from "./shared.js";

const HEARTBEAT_INTERVAL_MS = 30_000;

async function driverDependencies() {
  const deps = await getConfiguredNativeT3RunDriverDependencies();
  if (!deps) {
    throw ApplicationFailure.nonRetryable(
      "Native T3 run durability is not configured",
      "NativeT3RunStateError",
    );
  }
  return deps;
}

/**
 * Execute or resume one native T3 run. Runs in the controller process with
 * access to the configured gateway/durability singletons; all run state is
 * loaded from Postgres so any controller instance can pick up any attempt.
 */
export async function driveNativeT3RunActivity(
  input: NativeT3RunWorkflowInput,
): Promise<NativeT3RunOutcome> {
  const context = Context.current();
  const deps = await driverDependencies();
  // Provisioning and snapshot restores can block for minutes without a
  // progress callback; a steady heartbeat keeps cancellation delivery and
  // worker-loss detection working through those gaps.
  const heartbeatTimer = setInterval(
    () => context.heartbeat("waiting on native T3 worker"),
    HEARTBEAT_INTERVAL_MS,
  );
  heartbeatTimer.unref();
  try {
    return await driveNativeT3Run(deps, input.runId, {
      signal: context.cancellationSignal,
      heartbeat: (detail) => context.heartbeat(detail),
    });
  } catch (error) {
    if (error instanceof NativeT3RunStateError) {
      throw ApplicationFailure.nonRetryable(error.message, error.name);
    }
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
  }
}

export async function finalizeNativeT3RunActivity(input: {
  runId: string;
  cancelled: boolean;
  message: string;
}): Promise<void> {
  const deps = await driverDependencies();
  await finalizeNativeT3Run(deps, input.runId, {
    cancelled: input.cancelled,
    message: input.message,
  });
}

/**
 * Build and publish a fresh golden worker template. The build proves itself
 * by running the same scripts a real thread runs; a failed build leaves the
 * previously published template untouched.
 */
export async function buildT3WorkerTemplateActivity(): Promise<{
  snapshotId: string;
  repoSha: string;
  backupKey: string;
  builtAt: string;
}> {
  const context = Context.current();
  const runtime = await getConfiguredThreadPersistence();
  if (!runtime) {
    throw ApplicationFailure.nonRetryable(
      "Thread persistence is not configured",
      "NativeT3RunStateError",
    );
  }
  const heartbeatTimer = setInterval(
    () => context.heartbeat("building worker template"),
    HEARTBEAT_INTERVAL_MS,
  );
  heartbeatTimer.unref();
  try {
    return await buildT3WorkerTemplate({
      metadata: runtime.persistence.stores.metadata,
    });
  } finally {
    clearInterval(heartbeatTimer);
  }
}
