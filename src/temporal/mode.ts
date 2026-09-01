/**
 * Orchestrator selection for native T3 runs.
 *
 * "temporal": /hosted/t3/chat launches a durable Temporal workflow per run.
 *   The drive activity survives controller restarts by resuming projection
 *   from the durable event log, and a finalize activity guarantees every run
 *   converges to a terminal status.
 * "in-process": the pre-Temporal behavior — the run is driven by a
 *   fire-and-forget promise inside the controller process and a restart
 *   orphans it. Retained as the rollback path.
 *
 * This is a code-level kill switch by design (like RUN_MEMORY_MODE): flipping
 * it is a reviewed commit, not an environment mutation.
 */
export const NATIVE_T3_RUN_ORCHESTRATOR: "temporal" | "in-process" = "temporal";
