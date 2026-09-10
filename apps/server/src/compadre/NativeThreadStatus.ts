import type { OrchestrationEvent } from "@t3tools/contracts";
import type { ThreadBackgroundLivenessService } from "../orchestration/ThreadBackgroundLiveness.ts";
import type { ThreadPlanProgressService } from "../orchestration/ThreadPlanProgress.ts";

/** Fold native activities into the same sidebar status services as local ingestion. */
export function nativeThreadStatusRecorder(
  background: ThreadBackgroundLivenessService["Service"],
  plans: ThreadPlanProgressService["Service"],
) {
  const clear = (threadId: string) => {
    background.clearThreadLiveness(threadId);
    plans.clearThreadPlanProgress(threadId);
  };
  const activity = (threadId: string, kind: string, value: unknown) => {
    if (kind === "provider.turn.completed") plans.clearThreadPlanProgress(threadId);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    const payload = value as Record<string, unknown>;
    const taskKind =
      kind === "task.started"
        ? "started"
        : kind === "task.progress"
          ? "progress"
          : kind === "task.updated"
            ? "updated"
            : kind === "task.completed"
              ? "completed"
              : null;
    if (taskKind && typeof payload.taskId === "string")
      background.recordTaskLiveness({
        threadId,
        taskId: payload.taskId,
        kind: taskKind,
        taskType: typeof payload.taskType === "string" ? payload.taskType : undefined,
        status: typeof payload.status === "string" ? payload.status : undefined,
        agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
      });
    if (kind === "turn.plan.updated" && Array.isArray(payload.plan)) {
      const plan = payload.plan.filter(
        (step): step is { step: string; status: string } =>
          step !== null &&
          typeof step === "object" &&
          typeof step.step === "string" &&
          typeof step.status === "string",
      );
      plans.recordPlanProgress(threadId, plan);
    }
  };
  return {
    activity,
    clear,
    event(event: OrchestrationEvent) {
      if (event.metadata.adapterKey !== "compadre-native") return;
      if (event.type === "thread.activity-appended")
        activity(
          event.payload.threadId,
          event.payload.activity.kind,
          event.payload.activity.payload,
        );
      if (
        event.type === "thread.session-set" &&
        ["stopped", "error"].includes(event.payload.session.status)
      )
        clear(event.payload.threadId);
    },
  };
}
