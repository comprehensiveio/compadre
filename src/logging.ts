import { AsyncLocalStorage } from "node:async_hooks";
import { pino } from "pino";

/**
 * Structured logging for compadre.
 *
 * Every event is one single-line JSON record, so Datadog stops splitting
 * multi-line `console` inspections into orphan fragments, derives `status`
 * from the pino level, and dd-trace injects `dd.trace_id` / `dd.span_id` /
 * `dd.service` / `dd.env` / `dd.version` automatically (DD_LOGS_INJECTION is
 * defaulted on in process-bootstrap).
 *
 * Use `log` for one-off events and pass ids explicitly, or wrap a unit of
 * work in `withLogContext({ canonicalThreadId, runId, sandboxId }, fn)` so
 * every log line inside — however deep — carries the correlation ids.
 */

export interface LogContext {
  canonicalThreadId?: string;
  centralThreadId?: string;
  runId?: string;
  sandboxId?: string;
  workerGeneration?: number;
  slackChannelId?: string;
  slackThreadTs?: string;
  [key: string]: unknown;
}

const contextStorage = new AsyncLocalStorage<LogContext>();

const root = pino({
  // Datadog maps pino levels to status natively.
  level: process.env.COMPADRE_LOG_LEVEL ?? "info",
  // Keep `message` as the Datadog-conventional key.
  messageKey: "message",
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  // The run context is merged into every record at write time, so child
  // loggers are unnecessary and context set deep inside a run still applies.
  mixin() {
    return contextStorage.getStore() ?? {};
  },
});

export const log = root;

/** Run `fn` with correlation ids attached to every log record inside it. */
export function withLogContext<T>(context: LogContext, fn: () => T): T {
  const parent = contextStorage.getStore();
  return contextStorage.run({ ...parent, ...context }, fn);
}

/** Merge additional ids into the active context (no-op without one). */
export function extendLogContext(context: LogContext): void {
  const store = contextStorage.getStore();
  if (store) Object.assign(store, context);
}

/**
 * Flatten any thrown value into single-line, queryable fields. Preserves the
 * structured fields of known error classes (e.g. T3GatewayError's
 * kind/operation/status/code) that string formatting used to discard.
 */
export function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { errorMessage: String(error), errorName: typeof error };
  }
  const extra: Record<string, unknown> = {};
  for (const key of ["kind", "operation", "status", "code", "sandboxId"] as const) {
    const value = (error as unknown as Record<string, unknown>)[key];
    if (value !== undefined) extra[`error${key[0].toUpperCase()}${key.slice(1)}`] = value;
  }
  return {
    errorName: error.name,
    errorMessage: error.message,
    // One line: Datadog renders escaped newlines fine and the record stays whole.
    errorStack: error.stack,
    ...(error.cause instanceof Error
      ? { errorCause: `${error.cause.name}: ${error.cause.message}` }
      : {}),
    ...extra,
  };
}
