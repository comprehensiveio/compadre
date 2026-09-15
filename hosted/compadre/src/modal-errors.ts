export const MODAL_SPEND_LIMIT_ERROR_CODE =
  "MODAL_SPEND_LIMIT_EXCEEDED";

export const MODAL_SPEND_LIMIT_ERROR_MESSAGE =
  "Compadre couldn't start because the Modal workspace has exceeded its spend limit.";

const SPEND_LIMIT_PATTERN = /exceeded its spend limit/i;

/** Only a missing/expired image at Modal provisioning permits a fresh cold worker. */
export function isModalSnapshotUnavailableError(
  error: unknown,
  snapshotId: string,
): boolean {
  if (!(error instanceof Error)) return false;
  const record = error as Error & {
    code?: number;
    path?: string;
    details?: string;
  };
  const message = record.details ?? record.message;
  return (
    (record.code === 5 || record.message.includes("NOT_FOUND:")) &&
    /\/(SandboxCreate|ImageGet)\b/.test(record.path ?? record.message) &&
    message.includes(snapshotId) &&
    /\bImage\b/i.test(message) &&
    /has expired|not found|does not exist/i.test(message)
  );
}

/** Match Modal's bounded billing rejection without exposing workspace details. */
export function isModalSpendLimitError(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;

  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    if (typeof current === "string") {
      return SPEND_LIMIT_PATTERN.test(current);
    }
    if (typeof current !== "object" || current === null || seen.has(current)) {
      return false;
    }

    seen.add(current);
    const record = current as Record<string, unknown>;
    if (
      (typeof record.message === "string" &&
        SPEND_LIMIT_PATTERN.test(record.message)) ||
      (typeof record.details === "string" &&
        SPEND_LIMIT_PATTERN.test(record.details))
    ) {
      return true;
    }
    current = record.cause;
  }

  return false;
}
