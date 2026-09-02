import type { ModelMessage, RunRecord, StreamChunk } from "@tanstack/ai";
import type { InterruptRecord } from "@tanstack/ai-persistence";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const aiRuns = pgTable(
  "compadre_ai_runs",
  {
    runId: text("run_id").primaryKey(),
    threadId: text("thread_id").notNull(),
    status: text("status").$type<RunRecord["status"]>().notNull(),
    startedAtMs: bigint("started_at_ms", { mode: "number" }).notNull(),
    finishedAtMs: bigint("finished_at_ms", { mode: "number" }),
    error: jsonb("error").$type<RunRecord["error"]>(),
    usage: jsonb("usage").$type<RunRecord["usage"]>(),
    sandboxKey: text("sandbox_key"),
    detachedSinceMs: bigint("detached_since_ms", { mode: "number" }),
    cancelRequested: boolean("cancel_requested"),
    driverEpoch: bigint("driver_epoch", { mode: "number" }),
  },
  (table) => [
    check(
      "compadre_ai_runs_status_check",
      sql`${table.status} in ('running', 'interrupted', 'completed', 'failed', 'aborted')`,
    ),
    index("compadre_ai_runs_thread_started_idx").on(
      table.threadId,
      table.startedAtMs,
    ),
    index("compadre_ai_runs_reclaimable_idx")
      .on(table.detachedSinceMs)
      .where(
        sql`${table.status} = 'running' and ${table.detachedSinceMs} is not null`,
      ),
  ],
);

export const aiStreams = pgTable("compadre_ai_streams", {
  runId: text("run_id").primaryKey(),
  nextSequence: bigint("next_sequence", { mode: "number" })
    .notNull()
    .default(1),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const aiStreamEvents = pgTable(
  "compadre_ai_stream_events",
  {
    runId: text("run_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    chunk: jsonb("chunk").$type<StreamChunk>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.runId, table.sequence],
      name: "compadre_ai_stream_events_pkey",
    }),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [aiStreams.runId],
      name: "compadre_ai_stream_events_run_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const aiThreads = pgTable("compadre_ai_threads", {
  threadId: text("thread_id").primaryKey(),
  messages: jsonb("messages").$type<ModelMessage[]>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const aiInterrupts = pgTable(
  "compadre_ai_interrupts",
  {
    interruptId: text("interrupt_id").primaryKey(),
    runId: text("run_id").notNull(),
    threadId: text("thread_id").notNull(),
    status: text("status").$type<InterruptRecord["status"]>().notNull(),
    requestedAtMs: bigint("requested_at_ms", { mode: "number" }).notNull(),
    resolvedAtMs: bigint("resolved_at_ms", { mode: "number" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    response: jsonb("response").$type<unknown>(),
  },
  (table) => [
    check(
      "compadre_ai_interrupts_status_check",
      sql`${table.status} in ('pending', 'resolved', 'cancelled')`,
    ),
    index("compadre_ai_interrupts_thread_requested_idx").on(
      table.threadId,
      table.requestedAtMs,
    ),
    index("compadre_ai_interrupts_run_requested_idx").on(
      table.runId,
      table.requestedAtMs,
    ),
  ],
);

export const aiMetadata = pgTable(
  "compadre_ai_metadata",
  {
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").$type<unknown>().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.namespace, table.key],
      name: "compadre_ai_metadata_pkey",
    }),
  ],
);

export type CompadreUserStatus = "active" | "disabled";

/** Canonical people known to Compadre, independent of any login provider. */
export const users = pgTable(
  "compadre_users",
  {
    id: uuid("id").primaryKey(),
    displayName: text("display_name").notNull(),
    realName: text("real_name"),
    avatarUrl: text("avatar_url"),
    email: text("email"),
    status: text("status")
      .$type<CompadreUserStatus>()
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "compadre_users_status_check",
      sql`${table.status} in ('active', 'disabled')`,
    ),
  ],
);

export interface SlackIdentityProfile {
  displayName?: string;
  realName?: string;
  avatarUrl?: string;
  email?: string;
}

/** External identities that resolve to one canonical Compadre user. */
export const userIdentities = pgTable(
  "compadre_user_identities",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").$type<"slack">().notNull(),
    providerWorkspaceId: text("provider_workspace_id").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    profile: jsonb("profile").$type<SlackIdentityProfile>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("compadre_user_identities_provider_subject_key").on(
      table.provider,
      table.providerWorkspaceId,
      table.providerUserId,
    ),
    index("compadre_user_identities_user_idx").on(table.userId),
  ],
);

/** Short-lived server-side Slack OIDC state; no browser token is persisted. */
export const authLoginFlows = pgTable(
  "compadre_auth_login_flows",
  {
    stateHash: text("state_hash").primaryKey(),
    nonce: text("nonce").notNull(),
    returnTo: text("return_to").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("compadre_auth_login_flows_expires_idx").on(table.expiresAt)],
);

/** One-time handoff from the controller to the hosted T3 session issuer. */
export const authLoginGrants = pgTable(
  "compadre_auth_login_grants",
  {
    codeHash: text("code_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    returnTo: text("return_to").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("compadre_auth_login_grants_expires_idx").on(table.expiresAt)],
);

export type SlackTurnDeliveryStatus =
  | "pending"
  | "delivering"
  | "delivered"
  | "dead";

/**
 * Durable outbox for the final Slack response of a native T3 turn. The T3
 * orchestration log remains the source of response text; this row records
 * enough of the dispatch to recover delivery after a controller rollout.
 */
export const slackTurnDeliveries = pgTable(
  "compadre_slack_turn_deliveries",
  {
    id: uuid("id").primaryKey(),
    messageId: text("message_id").notNull(),
    canonicalThreadId: text("canonical_thread_id").notNull(),
    t3ThreadId: text("t3_thread_id").notNull(),
    environmentId: text("environment_id").notNull(),
    dispatchSequence: bigint("dispatch_sequence", { mode: "number" }).notNull(),
    dispatchCreatedAt: timestamp("dispatch_created_at", {
      withTimezone: true,
    }).notNull(),
    slackTeamId: text("slack_team_id").notNull(),
    slackChannelId: text("slack_channel_id").notNull(),
    slackThreadTs: text("slack_thread_ts").notNull(),
    triggerMessageTs: text("trigger_message_ts").notNull(),
    recipientUserId: text("recipient_user_id"),
    detailsUrl: text("details_url").notNull(),
    status: text("status")
      .$type<SlackTurnDeliveryStatus>()
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("compadre_slack_turn_deliveries_message_id_key").on(table.messageId),
    check(
      "compadre_slack_turn_deliveries_status_check",
      sql`${table.status} in ('pending', 'delivering', 'delivered', 'dead')`,
    ),
    check(
      "compadre_slack_turn_deliveries_attempts_check",
      sql`${table.attempts} >= 0`,
    ),
    index("compadre_slack_turn_deliveries_ready_idx")
      .on(table.nextAttemptAt, table.createdAt)
      .where(sql`${table.status} in ('pending', 'delivering')`),
  ],
);

export type PullRequestWatchStatus =
  | "waiting"
  | "delivering"
  | "notified"
  | "closed_unmerged";

export type SlackInboxEventStatus = "queued" | "processing" | "done" | "dead";

/**
 * Durable Slack ingress. A verified event is persisted here BEFORE the HTTP
 * 200 acknowledgment, so a controller crash or deploy between Slack's
 * delivery and turn dispatch can no longer lose a message. Rows are claimed
 * by the in-process inbox processor and marked done once the turn is durably
 * owned downstream (central dispatch plus outbox reservation).
 */
export const slackInboxEvents = pgTable(
  "compadre_slack_inbox_events",
  {
    /** Slack's event_id: stable across Slack's own delivery retries. */
    eventKey: text("event_key").primaryKey(),
    teamId: text("team_id"),
    botUserId: text("bot_user_id"),
    event: jsonb("event").notNull(),
    status: text("status")
      .$type<SlackInboxEventStatus>()
      .notNull()
      .default("queued"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "compadre_slack_inbox_events_status_check",
      sql`${table.status} in ('queued', 'processing', 'done', 'dead')`,
    ),
    check(
      "compadre_slack_inbox_events_attempts_check",
      sql`${table.attempts} >= 0`,
    ),
    index("compadre_slack_inbox_events_claimable_idx").on(
      table.status,
      table.nextAttemptAt,
    ),
  ],
);

export const pullRequestWatches = pgTable(
  "compadre_pr_watches",
  {
    id: uuid("id").primaryKey(),
    prNumber: integer("pr_number").notNull(),
    prUrl: text("pr_url").notNull(),
    slackTeamId: text("slack_team_id").notNull(),
    slackChannelId: text("slack_channel_id").notNull(),
    slackThreadTs: text("slack_thread_ts").notNull(),
    status: text("status")
      .$type<PullRequestWatchStatus>()
      .notNull()
      .default("waiting"),
    matchedProdCommit: text("matched_prod_commit"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    deliveryStartedAt: timestamp("delivery_started_at", {
      withTimezone: true,
    }),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    lastError: text("last_error"),
  },
  (table) => [
    check("compadre_pr_watches_pr_number_check", sql`${table.prNumber} > 0`),
    check(
      "compadre_pr_watches_status_check",
      sql`${table.status} in ('waiting', 'delivering', 'notified', 'closed_unmerged')`,
    ),
    unique(
      "compadre_pr_watches_pr_number_slack_team_id_slack_channel_i_key",
    ).on(
      table.prNumber,
      table.slackTeamId,
      table.slackChannelId,
      table.slackThreadTs,
    ),
    index("compadre_pr_watches_waiting_idx")
      .on(table.createdAt)
      .where(sql`${table.status} = 'waiting'`),
  ],
);

/**
 * Triggered prompts: stored prompt definitions fired by an external trigger
 * (cron schedules today; the trigger_type discriminator and JSON config leave
 * room for other sources later). Each row is mirrored to one Temporal
 * Schedule; fires dispatch a central T3 turn with origin "trigger"
 * attribution and deliver only the agent's answer to Slack.
 */
export type TriggeredPromptDeliveryMode =
  | "new_thread"
  | "same_thread"
  | "existing_thread";

export const triggeredPrompts = pgTable(
  "compadre_triggered_prompts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    prompt: text("prompt").notNull(),
    triggerType: text("trigger_type").notNull().default("cron"),
    /** Per-type config; for 'cron': { cronExpression, timezone? }. */
    triggerConfig: jsonb("trigger_config")
      .$type<{ cronExpression: string; timezone?: string }>()
      .notNull(),
    deliveryMode: text("delivery_mode")
      .$type<TriggeredPromptDeliveryMode>()
      .notNull()
      .default("new_thread"),
    /** Slack channel for new_thread/same_thread fires; null for existing_thread. */
    slackChannelId: text("slack_channel_id"),
    /** existing_thread only: the central T3 thread the prompt fires into. */
    targetThreadId: text("target_thread_id"),
    enabled: boolean("enabled").notNull().default(true),
    /** Canonical user id of the creator when known; shown in the UI. */
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    lastCentralThreadId: text("last_central_thread_id"),
  },
  (table) => [
    check(
      "compadre_triggered_prompts_delivery_mode_check",
      sql`${table.deliveryMode} in ('new_thread', 'same_thread', 'existing_thread')`,
    ),
  ],
);
