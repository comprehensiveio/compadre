import type { AgentProfile } from "../tanstack/protocol.js";
import {
  createCentralT3AguiStream,
  createCentralT3AguiRecoveryStream,
  type CentralT3AguiStreamInput,
} from "../t3/agui-stream.js";
import { centralT3ThreadId } from "../t3/central-conversation.js";
import type {
  T3Client,
  T3MessageAttribution,
  T3ModelSelection,
} from "../t3/client.js";
import type { CentralT3ConversationClient } from "../t3/central-conversation.js";
import type {
  NativeT3RunCoordinator,
  NativeT3RunStartResult,
} from "../t3/run-coordinator.js";

export interface StartCentralT3DurableRunInput {
  coordinator: NativeT3RunCoordinator;
  client: CentralT3ConversationClient & Pick<T3Client, "interruptTurn">;
  runId: string;
  threadId: string;
  title: string;
  prompt: string;
  displayText?: string;
  attribution?: T3MessageAttribution;
  profile?: AgentProfile;
  modelSelection?: T3ModelSelection;
  onPrepared?: CentralT3AguiStreamInput["onPrepared"];
}

export const CENTRAL_T3_COMPATIBILITY_RECOVERY_KEY =
  "central-t3-api-compatibility";

/** Stable attribution for callers authenticated by the shared relay API key. */
export function apiMessageAttribution(input: {
  userId?: string;
  displayName?: string;
} = {}): T3MessageAttribution {
  return {
    userId: input.userId?.trim() || "compadre-api",
    displayName: input.displayName?.trim() || "Compadre API",
    origin: "api",
  };
}

/**
 * Start one central hosted-T3 turn behind the durable legacy run facade.
 * Disconnecting an HTTP reader never cancels the producer; explicit run
 * cancellation interrupts the authoritative central T3 turn.
 */
export async function startCentralT3DurableRun(
  input: StartCentralT3DurableRunInput,
): Promise<NativeT3RunStartResult> {
  let activeThreadId: string | undefined;
  return input.coordinator.start({
    runId: input.runId,
    threadId: input.threadId,
    recoveryKey: CENTRAL_T3_COMPATIBILITY_RECOVERY_KEY,
    source(signal) {
      return createCentralT3AguiStream({
        client: input.client,
        canonicalThreadId: input.threadId,
        runId: input.runId,
        title: input.title,
        text: input.prompt,
        displayText: input.displayText,
        attribution: input.attribution,
        profile: input.profile,
        modelSelection: input.modelSelection,
        signal,
        async onPrepared(prepared) {
          activeThreadId = prepared.t3ThreadId;
          await input.onPrepared?.(prepared);
        },
      });
    },
    async cancel() {
      if (!activeThreadId) return;
      await input.client.interruptTurn({ threadId: activeThreadId });
    },
  });
}

/** Reattach API compatibility streams whose controller exited mid-turn. */
export async function recoverCentralT3DurableRuns(input: {
  coordinator: NativeT3RunCoordinator;
  client: CentralT3ConversationClient &
    Pick<T3Client, "interruptTurn" | "threadSnapshot">;
}): Promise<{ scanned: number; resumed: number; skipped: number }> {
  const runs = await input.coordinator.recoverableRuns(
    CENTRAL_T3_COMPATIBILITY_RECOVERY_KEY,
  );
  let resumed = 0;
  let skipped = 0;
  for (const run of runs) {
    try {
      const result = await input.coordinator.resume({
        runId: run.runId,
        threadId: run.threadId,
        recoveryKey: CENTRAL_T3_COMPATIBILITY_RECOVERY_KEY,
        source(signal) {
          return createCentralT3AguiRecoveryStream({
            client: input.client,
            canonicalThreadId: run.threadId,
            runId: run.runId,
            startedAt: run.startedAt,
            signal,
          });
        },
        cancel() {
          return input.client.interruptTurn({
            threadId: centralT3ThreadId(run.threadId),
          }).then(() => undefined);
        },
      });
      if (result.resumed) resumed += 1;
      else skipped += 1;
      console.log("[central-t3-recovery] compatibility run reconciliation", {
        runId: run.runId,
        canonicalThreadId: run.threadId,
        resumed: result.resumed,
        priorDriverEpoch: run.driverEpoch ?? 0,
      });
    } catch (error) {
      skipped += 1;
      console.error("[central-t3-recovery] compatibility run resume failed", {
        runId: run.runId,
        canonicalThreadId: run.threadId,
        error,
      });
    }
  }
  return { scanned: runs.length, resumed, skipped };
}
