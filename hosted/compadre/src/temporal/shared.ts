import { createHash } from "node:crypto";

/** All Compadre native-T3 workflows and activities poll this queue. */
export const NATIVE_T3_TASK_QUEUE = "compadre-native-t3";

export const DEFAULT_TEMPORAL_ADDRESS = "localhost:7243";
export const DEFAULT_TEMPORAL_NAMESPACE = "compadre";

/** Workflow input; the full run request is persisted in Postgres, not here. */
export interface NativeT3RunWorkflowInput {
  runId: string;
  threadId: string;
}

export interface NativeT3RunWorkflowResult {
  status: "completed" | "failed" | "aborted";
}

export interface PreviewActivationWorkflowInput {
  canonicalThreadId: string;
  activationId: string;
}

export function temporalAddress(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return environment.TEMPORAL_ADDRESS?.trim() || DEFAULT_TEMPORAL_ADDRESS;
}

export function temporalNamespace(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return environment.TEMPORAL_NAMESPACE?.trim() || DEFAULT_TEMPORAL_NAMESPACE;
}

/**
 * Deterministic workflow id per run id. Restarting a request with the same
 * run id reattaches to the same workflow instead of launching a duplicate.
 */
export function nativeT3RunWorkflowId(runId: string): string {
  const digest = createHash("sha256")
    .update(runId)
    .digest("base64url")
    .slice(0, 32);
  return `compadre-t3-${digest}`;
}

export function previewActivationWorkflowId(activationId: string): string {
  return `compadre-preview-${activationId}`;
}
