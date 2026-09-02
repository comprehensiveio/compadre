import { z } from "zod";

/**
 * Triggered prompts: stored prompt definitions fired by an external trigger.
 * Only cron schedules exist today; the trigger_type discriminator and JSON
 * trigger config leave room for other sources (webhooks, events) later.
 *
 * Fires dispatch straight to central T3 with origin "trigger" attribution,
 * so the web UI shows trigger provenance per message. Only the agent's
 * answer is posted to Slack — the prompt itself never appears there. The
 * provider and model come from the central project/thread like any hosted
 * conversation.
 *
 * This module is imported by workflow code, so it must stay free of I/O
 * imports (no pg, no Slack, no persistence runtime).
 */

export type TriggerType = "cron";

export type DeliveryMode = "new_thread" | "same_thread" | "existing_thread";

export interface CronTriggerConfig {
  cronExpression: string;
  /** IANA timezone for the cron expression; UTC when omitted. */
  timezone?: string;
}

export interface TriggeredPromptRecord {
  id: string;
  name: string;
  prompt: string;
  triggerType: TriggerType;
  triggerConfig: CronTriggerConfig;
  deliveryMode: DeliveryMode;
  /**
   * Slack channel the answer posts to. Required for same_thread (the first
   * answer's Slack root anchors the conversation), optional for new_thread
   * (a web-only fire — useful when the prompt has the agent deliver its own
   * updates), absent for existing_thread.
   */
  slackChannelId?: string;
  /**
   * existing_thread only: the central T3 thread to fire into. Web-only
   * threads get a direct central turn; Slack-linked threads also get the
   * answer posted into their Slack thread.
   */
  targetThreadId?: string;
  enabled: boolean;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  lastFiredAt?: string;
  lastCentralThreadId?: string;
}

/** Input to the triggeredPromptWorkflow started by the Temporal Schedule. */
export interface TriggeredPromptWorkflowInput {
  triggerId: string;
}

/** How a fire reached the agent, recorded for the UI. */
export interface TriggeredPromptDeliveryResult {
  /** Central T3 thread id the turn was dispatched to. */
  centralThreadId: string;
  delivery: DeliveryMode;
}

const CRON_FIELD = /^[0-9*/,\-A-Za-z?]+$/;
const CRON_MACROS = new Set([
  "@yearly",
  "@annually",
  "@monthly",
  "@weekly",
  "@daily",
  "@midnight",
  "@hourly",
]);

/**
 * Lightweight cron sanity check. Temporal is the authority — it rejects
 * invalid expressions when the schedule is created — but this catches obvious
 * mistakes before anything is persisted.
 */
export function validateCronExpression(expression: string): string | undefined {
  const trimmed = expression.trim();
  if (!trimmed) return "Cron expression is required";
  if (trimmed.startsWith("@")) {
    return CRON_MACROS.has(trimmed)
      ? undefined
      : `Unknown cron macro: ${trimmed}`;
  }
  const fields = trimmed.split(/\s+/);
  if (fields.length < 5 || fields.length > 6) {
    return `Cron expression must have 5 fields (minute hour day month weekday), got ${fields.length}`;
  }
  const bad = fields.find((field) => !CRON_FIELD.test(field));
  if (bad) return `Invalid cron field: ${bad}`;
  return undefined;
}

export const triggeredPromptInputSchema = z
  .object({
    name: z.string().trim().min(1, "name is required").max(200),
    prompt: z.string().trim().min(1, "prompt is required"),
    triggerType: z.literal("cron").default("cron"),
    cronExpression: z.string().trim().min(1, "cronExpression is required"),
    timezone: z.string().trim().min(1).optional(),
    deliveryMode: z
      .enum(["new_thread", "same_thread", "existing_thread"])
      .default("new_thread"),
    slackChannelId: z
      .string()
      .trim()
      .regex(
        /^[CDG][A-Z0-9]+$/,
        "slackChannelId must be a Slack channel id (e.g. C0123456789)",
      )
      .optional(),
    targetThreadId: z
      .string()
      .trim()
      .uuid(
        "targetThreadId must be a Compadre thread id (the UUID in the thread URL)",
      )
      .optional(),
    enabled: z.boolean().default(true),
    createdBy: z.string().trim().min(1).optional(),
  })
  .superRefine((value, context) => {
    const cronError = validateCronExpression(value.cronExpression);
    if (cronError) {
      context.addIssue({
        code: "custom",
        path: ["cronExpression"],
        message: cronError,
      });
    }
    if (value.deliveryMode === "existing_thread") {
      if (!value.targetThreadId) {
        context.addIssue({
          code: "custom",
          path: ["targetThreadId"],
          message: "targetThreadId is required for existing_thread delivery",
        });
      }
    } else {
      // same_thread is anchored by the first answer's Slack root, so it needs
      // a channel; new_thread may run web-only (no Slack answer delivery).
      if (value.deliveryMode === "same_thread" && !value.slackChannelId) {
        context.addIssue({
          code: "custom",
          path: ["slackChannelId"],
          message: "slackChannelId is required for same_thread delivery",
        });
      }
      if (value.targetThreadId) {
        context.addIssue({
          code: "custom",
          path: ["targetThreadId"],
          message: "targetThreadId is only allowed for existing_thread delivery",
        });
      }
    }
  });

export type TriggeredPromptInput = z.infer<typeof triggeredPromptInputSchema>;

export function triggeredPromptScheduleId(triggerId: string): string {
  return `triggered-prompt-${triggerId}`;
}
