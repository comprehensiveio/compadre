import type { CompadreThreadOperation } from "@t3tools/contracts";

export type ThreadOperationsFilter = "all" | "working" | "running" | "problems" | "unknown";
export type ThreadOperationsSort = "activity" | "created";

export function lastActivityAt(thread: CompadreThreadOperation): string {
  return [
    thread.activeRun?.lastEvent?.at,
    thread.activeRun?.startedAt,
    thread.lastActiveAt,
    thread.createdAt,
  ]
    .filter((at): at is string => Boolean(at))
    .sort()
    .at(-1)!;
}

export function isObservationStale(thread: CompadreThreadOperation, nowMs = Date.now()): boolean {
  if (thread.container.workerState === "suspended") return false;
  const checkedAt = thread.environment?.checkedAt;
  return (
    !checkedAt || !Number.isFinite(Date.parse(checkedAt)) || nowMs - Date.parse(checkedAt) > 60_000
  );
}

export function filterThreadOperations(
  threads: ReadonlyArray<CompadreThreadOperation>,
  filter: ThreadOperationsFilter,
  query: string,
  sort: ThreadOperationsSort = "activity",
): ReadonlyArray<CompadreThreadOperation> {
  const normalizedQuery = query.trim().toLowerCase();
  return threads
    .filter((thread) => {
      if (filter === "working" && thread.status !== "working") return false;
      if (
        filter === "running" &&
        (thread.environment?.container ?? thread.container.status) !== "running"
      )
        return false;
      if (
        filter === "problems" &&
        thread.health === "healthy" &&
        thread.environment?.devServer !== "unresponsive"
      )
        return false;
      if (
        filter === "unknown" &&
        !isObservationStale(thread) &&
        thread.environment?.container !== "unknown" &&
        thread.environment?.database !== "unknown" &&
        thread.environment?.devServer !== "unknown"
      )
        return false;
      if (!normalizedQuery) return true;
      return [
        thread.title,
        thread.canonicalThreadId,
        thread.phase,
        thread.healthReason,
        thread.modelSelection.instanceId,
        thread.modelSelection.model,
        thread.container.sandboxId,
      ].some((value) => value.toLowerCase().includes(normalizedQuery));
    })
    .toSorted(
      (left, right) =>
        (sort === "created" ? right.createdAt : lastActivityAt(right)).localeCompare(
          sort === "created" ? left.createdAt : lastActivityAt(left),
        ) || left.canonicalThreadId.localeCompare(right.canonicalThreadId),
    );
}

export function containerLabel(thread: CompadreThreadOperation, nowMs = Date.now()): string {
  if (thread.container.workerState === "hibernating") return "Saving snapshot";
  if (thread.container.workerState === "restoring") return "Restoring";
  if (thread.container.workerState === "suspended") return "Suspended";
  if (thread.environment?.container === "stopped") return "Stopped";
  if (thread.container.workerState === "warm") {
    const remaining = Date.parse(thread.container.warmUntil ?? "") - nowMs;
    return remaining > 0 ? `Warm · sleeps in ${Math.ceil(remaining / 60_000)}m` : "Warm";
  }
  return thread.environment?.container === "running"
    ? "Running"
    : thread.container.status === "running"
      ? "Running (recorded)"
      : "Unknown";
}

export function formatOperationsAge(iso: string, nowMs = Date.now()): string {
  const elapsedMs = Math.max(0, nowMs - Date.parse(iso));
  if (!Number.isFinite(elapsedMs)) return "Unknown";
  if (elapsedMs < 60_000) return `${Math.floor(elapsedMs / 1_000)}s ago`;
  if (elapsedMs < 3_600_000) return `${Math.floor(elapsedMs / 60_000)}m ago`;
  if (elapsedMs < 86_400_000) return `${Math.floor(elapsedMs / 3_600_000)}h ago`;
  return `${Math.floor(elapsedMs / 86_400_000)}d ago`;
}
