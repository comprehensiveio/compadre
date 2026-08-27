import { SlackClient } from "./slack-client.js";
import {
  slackIdentityFromUserInfo,
  slackMessageAttribution,
  type SlackMessageAttribution,
  type SlackThreadParticipant,
  type UserDirectory,
} from "./user-directory.js";

export async function resolveSlackMessageAttribution(input: {
  directory: UserDirectory | null;
  botToken: string | undefined;
  workspaceId: string | undefined;
  slackUserId: string | undefined;
  channelId: string;
  messageTs: string;
  threadTs?: string;
  threadUrl?: string;
  participants?: SlackThreadParticipant[];
  fetchImpl?: typeof fetch;
}): Promise<SlackMessageAttribution | undefined> {
  const workspaceId = input.workspaceId?.trim();
  const slackUserId = input.slackUserId?.trim();
  if (!input.directory || !input.botToken || !workspaceId || !slackUserId) {
    return undefined;
  }

  const client = new SlackClient({
    botToken: input.botToken,
    teamId: workspaceId,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  const profile = slackIdentityFromUserInfo(
    await client.getUserInfo(slackUserId),
  );
  const user = await input.directory.upsertSlackIdentity({
    workspaceId,
    slackUserId,
    ...profile,
  });
  return slackMessageAttribution({
    user,
    workspaceId,
    slackUserId,
    channelId: input.channelId,
    messageTs: input.messageTs,
    threadTs: input.threadTs,
    threadUrl: input.threadUrl,
    participants: input.participants,
  });
}

/** Resolve the human Slack authors present in a conversation into canonical users. */
export async function resolveSlackThreadParticipants(input: {
  directory: UserDirectory | null;
  botToken: string | undefined;
  workspaceId: string | undefined;
  slackUserIds: ReadonlyArray<string>;
  fetchImpl?: typeof fetch;
}): Promise<SlackThreadParticipant[]> {
  const workspaceId = input.workspaceId?.trim();
  if (!input.directory || !input.botToken || !workspaceId) return [];

  const uniqueIds = [
    ...new Set(input.slackUserIds.map((id) => id.trim()).filter(Boolean)),
  ];
  const participants = await Promise.all(
    uniqueIds.map(async (slackUserId) => {
      const attribution = await resolveSlackMessageAttribution({
        directory: input.directory,
        botToken: input.botToken,
        workspaceId,
        slackUserId,
        channelId: "thread-participant",
        messageTs: "thread-participant",
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      });
      if (!attribution) return null;
      return {
        userId: attribution.userId,
        displayName: attribution.displayName,
        ...(attribution.avatarUrl ? { avatarUrl: attribution.avatarUrl } : {}),
        origins: ["slack"] as ["slack"],
      };
    }),
  );
  return participants.filter(
    (participant): participant is SlackThreadParticipant =>
      participant !== null,
  );
}
