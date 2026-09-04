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
import { deliverTriggeredPrompt } from "../triggers/deliver.js";
import { getConfiguredTriggeredPromptStore } from "../triggers/store.js";
import type {
  TriggeredPromptDeliveryResult,
  TriggeredPromptRecord,
} from "../triggers/types.js";
import type { NativeT3RunWorkflowInput } from "./shared.js";
import type { PreviewActivationWorkflowInput } from "./shared.js";
import { PreviewActivationStore } from "../services/preview-activation.js";
import { getConfiguredT3Gateway } from "../t3/runtime.js";

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

export async function activatePreviewActivity(
  input: PreviewActivationWorkflowInput,
): Promise<void> {
  const context = Context.current();
  const runtime = await getConfiguredThreadPersistence();
  const gateway = await getConfiguredT3Gateway();
  if (!runtime || !gateway) {
    throw ApplicationFailure.nonRetryable(
      "Preview activation requires configured thread persistence",
      "PreviewActivationStateError",
    );
  }
  const store = new PreviewActivationStore(
    runtime.persistence.stores.metadata,
    () => new Date(),
    runtime.locks,
  );
  const heartbeatTimer = setInterval(
    () => context.heartbeat("activating preview environment"),
    HEARTBEAT_INTERVAL_MS,
  );
  heartbeatTimer.unref();
  try {
    const target = await gateway.activatePreview({
      canonicalThreadId: input.canonicalThreadId,
      onPhase: async (phase) => {
        await store.update(input.canonicalThreadId, input.activationId, phase);
      },
    });
    if (!target) {
      throw ApplicationFailure.nonRetryable(
        "Preview thread was not found",
        "PreviewActivationStateError",
      );
    }
    await store.update(input.canonicalThreadId, input.activationId, "ready");
  } finally {
    clearInterval(heartbeatTimer);
  }
}

export async function recordPreviewActivationFailureActivity(input: {
  canonicalThreadId: string;
  activationId: string;
  message: string;
}): Promise<void> {
  const runtime = await getConfiguredThreadPersistence();
  if (!runtime) return;
  await new PreviewActivationStore(
    runtime.persistence.stores.metadata,
    () => new Date(),
    runtime.locks,
  ).update(
    input.canonicalThreadId,
    input.activationId,
    "failed",
    "The development environment could not be restored or started.",
  );
}

async function requiredTriggeredPromptStore() {
  const store = await getConfiguredTriggeredPromptStore();
  if (!store) {
    throw ApplicationFailure.nonRetryable(
      "Triggered prompts require Postgres thread persistence",
      "NativeT3RunStateError",
    );
  }
  return store;
}

export async function loadTriggeredPromptActivity(
  triggerId: string,
): Promise<TriggeredPromptRecord | null> {
  return (await requiredTriggeredPromptStore()).get(triggerId);
}

export async function deliverTriggeredPromptActivity(
  record: TriggeredPromptRecord,
): Promise<TriggeredPromptDeliveryResult> {
  return deliverTriggeredPrompt(record);
}

export async function recordTriggerFiredActivity(
  triggerId: string,
  result: TriggeredPromptDeliveryResult,
): Promise<void> {
  await (await requiredTriggeredPromptStore()).recordFired(triggerId, result);
}
