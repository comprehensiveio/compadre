import type { CompadreThreadOperation, CompadreThreadHealth } from "@t3tools/contracts";

export type ThreadOperationsFilter = "all" | "working" | CompadreThreadHealth;

export function filterThreadOperations(
  threads: ReadonlyArray<CompadreThreadOperation>,
  filter: ThreadOperationsFilter,
  query: string,
): ReadonlyArray<CompadreThreadOperation> {
  const normalizedQuery = query.trim().toLowerCase();
  return threads.filter((thread) => {
    if (filter === "working" && thread.status !== "working") return false;
    if (
      (filter === "healthy" || filter === "attention" || filter === "stuck") &&
      thread.health !== filter
    ) {
      return false;
    }
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
  });
}

export function formatOperationsAge(iso: string, nowMs = Date.now()): string {
  const elapsedMs = Math.max(0, nowMs - Date.parse(iso));
  if (elapsedMs < 60_000) return `${Math.floor(elapsedMs / 1_000)}s ago`;
  if (elapsedMs < 3_600_000) return `${Math.floor(elapsedMs / 60_000)}m ago`;
  if (elapsedMs < 86_400_000) return `${Math.floor(elapsedMs / 3_600_000)}h ago`;
  return `${Math.floor(elapsedMs / 86_400_000)}d ago`;
}
