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

export type PullRequestWatchStatus =
  | "waiting"
  | "delivering"
  | "notified"
  | "closed_unmerged";

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
