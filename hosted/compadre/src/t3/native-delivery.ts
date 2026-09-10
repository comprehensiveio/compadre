import { z } from "zod";
import type { T3BeforeTurnDispatch } from "./gateway.js";
import type { T3Client, T3ThreadSnapshot } from "./client.js";
import type { NativeT3RunRequest } from "./run-request-store.js";
import { NativeThreadDelivery, type NativeDeliveryState } from "./native-events.js";

export function nativeDeliveryCohortIncludes(threadId: string, environment: NodeJS.ProcessEnv = process.env): boolean {
  const cohort = environment.COMPADRE_NATIVE_EVENT_THREADS?.split(",").map((id) => id.trim()) ?? [];
  return cohort.includes("*") || cohort.includes(threadId);
}

function lastCheckpoint(snapshot: T3ThreadSnapshot): number {
  const checkpoints = snapshot.thread.checkpoints;
  if (!Array.isArray(checkpoints)) return 0;
  return checkpoints.reduce((last: number, value: unknown) => {
    if (!value || typeof value !== "object" || !("checkpointTurnCount" in value)) return last;
    return typeof value.checkpointTurnCount === "number" ? Math.max(last, value.checkpointTurnCount) : last;
  }, 0);
}

/** Called under the gateway's per-thread dispatch lock, before the provider request. */
export async function prepareNativeDelivery(input: {
  delivery: NativeThreadDelivery;
  central: T3Client;
  request: NativeT3RunRequest;
  connection: Parameters<T3BeforeTurnDispatch>[0];
  start(state: NativeDeliveryState): Promise<void>;
}): Promise<void> {
  if (process.env.COMPADRE_NATIVE_EVENTS_PAUSED === "true") throw new Error("Native event delivery is paused");
  const { binding, environment } = input.connection;
  if (!environment.client.nativeEventPage) throw new Error("Worker client does not support native events");
  const current = await input.delivery.get(binding.canonicalThreadId);
  let state: NativeDeliveryState;
  if (current && current.sandboxId === binding.sandboxId && current.sourceThreadId === binding.t3ThreadId) {
    state = { ...current, runId: input.request.runId };
  } else {
    const head = await environment.client.nativeEventPage({ threadId: binding.t3ThreadId, offset: "-1", head: true });
    const restoredJournal = current?.sourceThreadId === binding.t3ThreadId;
    let checkpointOffset = restoredJournal ? current.checkpointOffset : 0;
    if (!restoredJournal) {
      const [central, worker] = await Promise.all([
        input.central.threadSnapshot(binding.canonicalThreadId),
        environment.client.threadSnapshot(binding.t3ThreadId),
      ]);
      checkpointOffset = Math.max(0, lastCheckpoint(central) - lastCheckpoint(worker));
    }
    // A restored journal can lag the last acknowledgement. Replay its retained
    // prefix; central command receipts retain all already accepted output.
    const startOffset = current ? "00000000000000000000" : head.nextOffset;
    state = { version: 1, runId: input.request.runId, canonicalThreadId: binding.canonicalThreadId,
      sourceThreadId: binding.t3ThreadId, sandboxId: binding.sandboxId,
      epoch: current ? current.epoch + 1 : (binding.workerGeneration ?? 1),
      startOffset, offset: startOffset, checkpointOffset };
  }
  await input.delivery.bind(state);
  await input.start(state);
}

export const nativeControlSchema = z.object({
  sourceThreadId: z.string().min(1), epoch: z.number().int().positive(), commandId: z.string().min(1),
  type: z.enum(["thread.turn-interrupt-requested", "thread.session-stop-requested", "thread.approval-response-requested", "thread.user-input-response-requested"]),
  createdAt: z.string().datetime(), requestId: z.string().optional(),
  decision: z.enum(["accept", "acceptForSession", "acceptAlways", "decline", "cancel"]).optional(),
  answers: z.record(z.string(), z.unknown()).optional(),
});

export function nativeWorkerControl(input: z.infer<typeof nativeControlSchema>) {
  const { sourceThreadId, commandId, createdAt } = input;
  const base = { threadId: sourceThreadId, commandId, createdAt };
  if (input.type === "thread.turn-interrupt-requested") return { ...base, type: "thread.turn.interrupt" };
  if (input.type === "thread.session-stop-requested") return { ...base, type: "thread.session.stop" };
  const prefix = `compadre-native:${encodeURIComponent(sourceThreadId)}:`;
  if (!input.requestId?.startsWith(prefix)) throw new Error("Question belongs to a different worker journal");
  const requestId = input.requestId.slice(prefix.length);
  if (!requestId) throw new Error("Missing native request ID");
  if (input.type === "thread.approval-response-requested") {
    if (!input.decision) throw new Error("Missing approval decision");
    return { ...base, type: "thread.approval.respond", requestId, decision: input.decision };
  }
  if (!input.answers) throw new Error("Missing question answers");
  return { ...base, type: "thread.user-input.respond", requestId, answers: input.answers };
}
