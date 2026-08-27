import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { CompadreDatabase } from "../db/client.js";
import {
  userIdentities,
  users,
  type SlackIdentityProfile,
} from "../db/schema.js";

export interface CompadreUser {
  id: string;
  displayName: string;
  realName?: string;
  avatarUrl?: string;
  email?: string;
}

export interface SlackUserIdentityInput extends SlackIdentityProfile {
  workspaceId: string;
  slackUserId: string;
}

export interface SlackMessageAttribution {
  userId: string;
  displayName: string;
  avatarUrl?: string;
  origin: "slack";
  slack: {
    workspaceId: string;
    userId: string;
    channelId: string;
    messageTs: string;
    threadTs?: string;
    threadUrl?: string;
    participants?: SlackThreadParticipant[];
  };
}

export interface SlackThreadParticipant {
  userId: string;
  displayName: string;
  avatarUrl?: string;
  origins: ["slack"];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Decode the subset of users.info that is safe to cache for attribution. */
export function slackIdentityFromUserInfo(
  value: unknown,
): Omit<SlackUserIdentityInput, "workspaceId" | "slackUserId"> {
  const user = record(record(value)?.user);
  const profile = record(user?.profile);
  const realName =
    optionalString(profile?.real_name) ?? optionalString(user?.real_name);
  const displayName =
    optionalString(profile?.display_name) ??
    realName ??
    optionalString(user?.name) ??
    "Slack user";
  return {
    displayName,
    ...(realName ? { realName } : {}),
    ...((optionalString(profile?.image_192) ??
    optionalString(profile?.image_72))
      ? {
          avatarUrl:
            optionalString(profile?.image_192) ??
            optionalString(profile?.image_72),
        }
      : {}),
    ...(optionalString(profile?.email)
      ? { email: optionalString(profile?.email) }
      : {}),
  };
}

/** Decode identity claims from a verified Sign in with Slack ID token. */
export function slackIdentityFromOpenIdClaims(
  value: Record<string, unknown>,
): Omit<SlackUserIdentityInput, "workspaceId" | "slackUserId"> {
  const realName = optionalString(value.name);
  const displayName =
    optionalString(value.preferred_username) ?? realName ?? "Slack user";
  return {
    displayName,
    ...(realName ? { realName } : {}),
    ...(optionalString(value.picture)
      ? { avatarUrl: optionalString(value.picture) }
      : {}),
    ...(optionalString(value.email)
      ? { email: optionalString(value.email) }
      : {}),
  };
}

/** One canonical label for the same Slack identity across event and login APIs. */
export function canonicalSlackDisplayName(
  profile: Pick<SlackIdentityProfile, "displayName" | "realName">,
): string {
  return profile.realName?.trim() || profile.displayName?.trim() || "Slack user";
}

/** Stable for one Slack identity, while remaining an ordinary UUID. */
export function slackBackedUserId(
  workspaceId: string,
  slackUserId: string,
): string {
  const bytes = crypto
    .createHash("sha256")
    .update(`compadre:user:slack:${workspaceId}:${slackUserId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function identityId(workspaceId: string, slackUserId: string): string {
  return slackBackedUserId(`identity:${workspaceId}`, slackUserId);
}

function toCompadreUser(row: typeof users.$inferSelect): CompadreUser {
  return {
    id: row.id,
    displayName: row.displayName,
    ...(row.realName ? { realName: row.realName } : {}),
    ...(row.avatarUrl ? { avatarUrl: row.avatarUrl } : {}),
    ...(row.email ? { email: row.email } : {}),
  };
}

export class UserDirectory {
  constructor(
    private readonly db: CompadreDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async upsertSlackIdentity(
    input: SlackUserIdentityInput,
  ): Promise<CompadreUser> {
    const workspaceId = input.workspaceId.trim();
    const slackUserId = input.slackUserId.trim();
    if (!workspaceId || !slackUserId) {
      throw new Error("Slack workspace and user IDs are required");
    }
    const observedAt = this.now();
    const existing = await this.db
      .select({ userId: userIdentities.userId })
      .from(userIdentities)
      .where(
        and(
          eq(userIdentities.provider, "slack"),
          eq(userIdentities.providerWorkspaceId, workspaceId),
          eq(userIdentities.providerUserId, slackUserId),
        ),
      )
      .limit(1);
    const userId =
      existing[0]?.userId ?? slackBackedUserId(workspaceId, slackUserId);
    const profile: SlackIdentityProfile = {
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.realName ? { realName: input.realName } : {}),
      ...(input.avatarUrl ? { avatarUrl: input.avatarUrl } : {}),
      ...(input.email ? { email: input.email } : {}),
    };
    const displayName = canonicalSlackDisplayName(input);
    const realName = input.realName?.trim();
    const avatarUrl = input.avatarUrl?.trim();
    const email = input.email?.trim();

    await this.db.transaction(async (tx) => {
      await tx
        .insert(users)
        .values({
          id: userId,
          displayName,
          realName: realName || null,
          avatarUrl: avatarUrl || null,
          email: email || null,
          status: "active",
          createdAt: observedAt,
          updatedAt: observedAt,
          lastSeenAt: observedAt,
        })
        .onConflictDoUpdate({
          target: users.id,
          set: {
            displayName,
            ...(realName ? { realName } : {}),
            ...(avatarUrl ? { avatarUrl } : {}),
            ...(email ? { email } : {}),
            status: "active",
            updatedAt: observedAt,
            lastSeenAt: observedAt,
          },
        });
      await tx
        .insert(userIdentities)
        .values({
          id: identityId(workspaceId, slackUserId),
          userId,
          provider: "slack",
          providerWorkspaceId: workspaceId,
          providerUserId: slackUserId,
          profile,
          createdAt: observedAt,
          updatedAt: observedAt,
        })
        .onConflictDoUpdate({
          target: [
            userIdentities.provider,
            userIdentities.providerWorkspaceId,
            userIdentities.providerUserId,
          ],
          set: { profile, updatedAt: observedAt },
        });
    });

    // Re-read the winning identity after the transaction. Two first-time events may
    // race, and the unique identity constraint is authoritative about which
    // canonical user owns this Slack account.
    const identities = await this.db
      .select({ userId: userIdentities.userId })
      .from(userIdentities)
      .where(
        and(
          eq(userIdentities.provider, "slack"),
          eq(userIdentities.providerWorkspaceId, workspaceId),
          eq(userIdentities.providerUserId, slackUserId),
        ),
      )
      .limit(1);
    const resolvedUserId = identities[0]?.userId;
    if (!resolvedUserId) {
      throw new Error(
        `Slack identity ${workspaceId}/${slackUserId} was not persisted`,
      );
    }
    const rows = await this.db
      .select()
      .from(users)
      .where(eq(users.id, resolvedUserId))
      .limit(1);
    const user = rows[0];
    if (!user)
      throw new Error(`Compadre user ${resolvedUserId} was not persisted`);
    return toCompadreUser(user);
  }

  async findById(userId: string): Promise<CompadreUser | null> {
    const rows = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0] ? toCompadreUser(rows[0]) : null;
  }

  async findActiveById(userId: string): Promise<CompadreUser | null> {
    const rows = await this.db
      .select()
      .from(users)
      .where(and(eq(users.id, userId), eq(users.status, "active")))
      .limit(1);
    return rows[0] ? toCompadreUser(rows[0]) : null;
  }
}

export function slackMessageAttribution(input: {
  user: CompadreUser;
  workspaceId: string;
  slackUserId: string;
  channelId: string;
  messageTs: string;
  threadTs?: string;
  threadUrl?: string;
  participants?: SlackThreadParticipant[];
}): SlackMessageAttribution {
  return {
    userId: input.user.id,
    displayName: input.user.displayName,
    ...(input.user.avatarUrl ? { avatarUrl: input.user.avatarUrl } : {}),
    origin: "slack",
    slack: {
      workspaceId: input.workspaceId,
      userId: input.slackUserId,
      channelId: input.channelId,
      messageTs: input.messageTs,
      ...(input.threadTs ? { threadTs: input.threadTs } : {}),
      ...(input.threadUrl ? { threadUrl: input.threadUrl } : {}),
      ...(input.participants ? { participants: input.participants } : {}),
    },
  };
}
