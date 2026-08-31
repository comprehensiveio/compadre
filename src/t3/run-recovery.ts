import { isTerminalRunStatus } from "@tanstack/ai";
import { createNativeT3AguiRecoveryStream } from "./agui-stream.js";
import type { T3Gateway } from "./gateway.js";
import type { NativeT3RunCoordinator } from "./run-coordinator.js";

export interface NativeT3RecoverySummary {
  scanned: number;
  resumed: number;
  skipped: number;
}

/**
 * Reattach provider streams that were being projected when a controller died.
 * The binding's activeRunId is the durable join between the worker turn and
 * the controller event log; no new provider turn is dispatched here.
 */
export async function recoverNativeT3Runs(input: {
  gateway: T3Gateway;
  coordinator: NativeT3RunCoordinator;
}): Promise<NativeT3RecoverySummary> {
  const bindings = (await input.gateway.list()).filter(
    (binding) => binding.status === "working" && binding.activeRunId,
  );
  let resumed = 0;
  let skipped = 0;

  for (const binding of bindings) {
    const runId = binding.activeRunId!;
    const run = await input.coordinator.run(runId);
    if (!run || run.threadId !== binding.canonicalThreadId) {
      skipped += 1;
      console.error("[native-t3-recovery] invalid active run marker", {
        runId,
        canonicalThreadId: binding.canonicalThreadId,
      });
      await input.gateway.clearActiveRun(binding.canonicalThreadId, runId);
      continue;
    }
    if (isTerminalRunStatus(run.status)) {
      skipped += 1;
      await input.gateway.clearActiveRun(binding.canonicalThreadId, runId);
      continue;
    }

    const result = await input.coordinator.resume({
      runId,
      threadId: binding.canonicalThreadId,
      source(signal) {
        return createNativeT3AguiRecoveryStream({
          gateway: input.gateway,
          canonicalThreadId: binding.canonicalThreadId,
          runId,
          startedAt: run.startedAt,
          signal,
          onTurn() {
            return input.gateway.markActiveRun(binding.canonicalThreadId, runId);
          },
          onTerminal() {
            return input.gateway.clearActiveRun(binding.canonicalThreadId, runId);
          },
        });
      },
      cancel() {
        return input.gateway.cancel({
          canonicalThreadId: binding.canonicalThreadId,
          providerInstanceId: binding.providerInstanceId,
        }).then(() => undefined);
      },
    });
    if (result.resumed) resumed += 1;
    else skipped += 1;
  }

  return { scanned: bindings.length, resumed, skipped };
}
