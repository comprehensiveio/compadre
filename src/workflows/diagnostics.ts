import { createTelemetryContentRedactor } from "../tanstack/telemetry-content.js";

export function workflowErrorDetails(error: unknown): {
  errorName: string;
  errorMessage: string;
  errorStack?: string;
  errorCause?: string;
} {
  const redact = createTelemetryContentRedactor(process.env, 8_000);
  if (!(error instanceof Error)) {
    return {
      errorName: typeof error,
      errorMessage: redact(String(error)),
    };
  }
  return {
    errorName: error.name,
    errorMessage: redact(error.message),
    ...(error.stack ? { errorStack: redact(error.stack) } : {}),
    ...(error.cause === undefined
      ? {}
      : { errorCause: redact(String(error.cause)) }),
  };
}
