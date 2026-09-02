/**
 * Pure logic for the triggered-prompts settings page. Mirrors the controller's
 * validation rules so mistakes surface before a round trip; the controller
 * remains authoritative.
 */

export type TriggeredPromptDeliveryMode = "new_thread" | "same_thread" | "existing_thread";

export interface TriggeredPromptRecord {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly triggerType: "cron";
  readonly triggerConfig: { readonly cronExpression: string; readonly timezone?: string };
  readonly deliveryMode: TriggeredPromptDeliveryMode;
  readonly slackChannelId?: string;
  readonly targetThreadId?: string;
  readonly enabled: boolean;
  readonly createdBy?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastFiredAt?: string;
  readonly lastCentralThreadId?: string;
}

export interface TriggeredPromptDraft {
  readonly name: string;
  readonly prompt: string;
  readonly cronExpression: string;
  readonly timezone: string;
  readonly deliveryMode: TriggeredPromptDeliveryMode;
  readonly slackChannelId: string;
  /** existing_thread target: a Compadre thread URL or bare thread id. */
  readonly targetThread: string;
}

export const EMPTY_TRIGGERED_PROMPT_DRAFT: TriggeredPromptDraft = {
  name: "",
  prompt: "",
  cronExpression: "",
  timezone: "",
  deliveryMode: "new_thread",
  slackChannelId: "",
  targetThread: "",
};

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

/**
 * Accepts a Compadre thread URL (…/{environmentId}/{threadId}) or a bare
 * thread id and returns the thread id. Thread URLs put the thread id last, so
 * the final UUID in the input wins.
 */
export function parseCompadreThreadId(input: string): string | null {
  const matches = input.trim().match(UUID_PATTERN);
  return matches?.at(-1)?.toLowerCase() ?? null;
}

export const DELIVERY_MODE_LABELS: Readonly<Record<TriggeredPromptDeliveryMode, string>> = {
  new_thread: "New thread each fire",
  same_thread: "Repeats on one thread",
  existing_thread: "Existing thread",
};

export const DELIVERY_MODE_DESCRIPTIONS: Readonly<Record<TriggeredPromptDeliveryMode, string>> = {
  new_thread: "Every fire starts a fresh thread (answer posts to Slack, visible here too).",
  same_thread: "The first fire creates a thread; later fires continue the conversation there.",
  existing_thread:
    "Fires continue a Compadre thread you point it at — web-only or Slack-linked alike.",
};

const CRON_FIELD_PATTERN = /^[0-9*/,\-A-Za-z?]+$/u;
const CRON_MACROS = new Set([
  "@yearly",
  "@annually",
  "@monthly",
  "@weekly",
  "@daily",
  "@midnight",
  "@hourly",
]);

export function validateCronExpression(expression: string): string | null {
  const trimmed = expression.trim();
  if (!trimmed) return "Cron expression is required.";
  if (trimmed.startsWith("@")) {
    return CRON_MACROS.has(trimmed) ? null : `Unknown cron macro: ${trimmed}`;
  }
  const fields = trimmed.split(/\s+/u);
  if (fields.length < 5 || fields.length > 6) {
    return `Cron expressions need 5 fields (minute hour day month weekday), got ${fields.length}.`;
  }
  const invalidField = fields.find((field) => !CRON_FIELD_PATTERN.test(field));
  return invalidField ? `Invalid cron field: ${invalidField}` : null;
}

export function validateTriggeredPromptDraft(draft: TriggeredPromptDraft): string | null {
  if (!draft.name.trim()) return "Name is required.";
  if (!draft.prompt.trim()) return "Prompt is required.";
  const cronError = validateCronExpression(draft.cronExpression);
  if (cronError) return cronError;
  if (draft.deliveryMode === "existing_thread") {
    if (!parseCompadreThreadId(draft.targetThread)) {
      return "Paste the Compadre thread's URL (or its thread id).";
    }
    return null;
  }
  if (!/^[CDG][A-Z0-9]+$/u.test(draft.slackChannelId.trim())) {
    return "Slack channel ID must look like C0123456789.";
  }
  return null;
}

/** Build the create/update request body the proxy forwards to the controller. */
export function draftToRequestBody(draft: TriggeredPromptDraft): Record<string, unknown> {
  const timezone = draft.timezone.trim();
  const isExistingThread = draft.deliveryMode === "existing_thread";
  return {
    name: draft.name.trim(),
    prompt: draft.prompt.trim(),
    cronExpression: draft.cronExpression.trim(),
    ...(timezone ? { timezone } : {}),
    deliveryMode: draft.deliveryMode,
    ...(isExistingThread
      ? { targetThreadId: parseCompadreThreadId(draft.targetThread) }
      : { slackChannelId: draft.slackChannelId.trim() }),
    enabled: true,
  };
}

export function recordToDraft(record: TriggeredPromptRecord): TriggeredPromptDraft {
  return {
    name: record.name,
    prompt: record.prompt,
    cronExpression: record.triggerConfig.cronExpression,
    timezone: record.triggerConfig.timezone ?? "",
    deliveryMode: record.deliveryMode,
    slackChannelId: record.slackChannelId ?? "",
    targetThread: record.targetThreadId ?? "",
  };
}

export function describeTriggerSchedule(record: TriggeredPromptRecord): string {
  const { cronExpression, timezone } = record.triggerConfig;
  return timezone ? `${cronExpression} (${timezone})` : `${cronExpression} (UTC)`;
}
