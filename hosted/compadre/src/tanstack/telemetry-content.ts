const DEFAULT_MAX_CONTENT_LENGTH = 32_000;
const DEFAULT_MAX_TOOL_CONTENT_LENGTH = 8_000;
const TRUNCATION_MARKER = "…";
const REDACTED_VALUE = "[REDACTED]";
const UN_SERIALIZABLE_VALUE = "[unserializable]";
const SECRET_ENVIRONMENT_KEY =
  /(key|token|secret|password|credential|private|database_url|dsn|auth|cookie|webhook)/i;

export const TELEMETRY_MAX_CONTENT_LENGTH = DEFAULT_MAX_CONTENT_LENGTH;
function truncate(value: string, maxLength: number): string {
  if (maxLength <= 0 || value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - TRUNCATION_MARKER.length))}${TRUNCATION_MARKER}`;
}

function secretValues(environment: NodeJS.ProcessEnv): string[] {
  const rawSecrets = Object.entries(environment)
    .filter(
      ([key, value]) =>
        SECRET_ENVIRONMENT_KEY.test(key) &&
        typeof value === "string" &&
        value.length >= 8,
    )
    .map(([, value]) => value as string);
  const serializedSecrets = rawSecrets.map((secret) =>
    JSON.stringify(secret).slice(1, -1),
  );
  return [...new Set([...rawSecrets, ...serializedSecrets])].sort(
    (left, right) => right.length - left.length,
  );
}

/** Build a bounded, fail-closed redactor for prompt and completion content. */
export function createTelemetryContentRedactor(
  environment: NodeJS.ProcessEnv = process.env,
  maxLength = DEFAULT_MAX_CONTENT_LENGTH,
): (value: string) => string {
  const secrets = secretValues(environment);
  return (value) => {
    let redacted = value;
    for (const secret of secrets) {
      redacted = redacted.replaceAll(secret, REDACTED_VALUE);
    }
    return truncate(redacted, maxLength);
  };
}

/** Accumulate streamed content without allowing telemetry buffers to grow forever. */
export function appendTelemetryContent(
  existing: string | undefined,
  delta: string,
  maxLength = DEFAULT_MAX_TOOL_CONTENT_LENGTH,
): string {
  if (maxLength > 0 && (existing?.length ?? 0) >= maxLength) {
    return existing ?? "";
  }
  return truncate(`${existing ?? ""}${delta}`, maxLength);
}

/** Safely serialize tool arguments/results and bound the retained value. */
export function serializeTelemetryValue(
  value: unknown,
  maxLength = DEFAULT_MAX_TOOL_CONTENT_LENGTH,
): string {
  if (typeof value === "string") return truncate(value, maxLength);
  try {
    return truncate(JSON.stringify(value ?? null), maxLength);
  } catch {
    return UN_SERIALIZABLE_VALUE;
  }
}

export function genAiMessagesAttribute(
  role: "user" | "assistant" | "tool",
  value: string,
  redact: (value: string) => string,
): string {
  return JSON.stringify([{ role, content: redact(value) }]);
}
