import { SlackClient } from "./slack-client.js";
import {
  slackIdentityFromUserInfo,
  slackMessageAttribution,
  type SlackMessageAttribution,
  type UserDirectory,
} from "./user-directory.js";

export async function resolveSlackMessageAttribution(input: {
  directory: UserDirectory | null;
  botToken: string | undefined;
  workspaceId: string | undefined;
  slackUserId: string | undefined;
  channelId: string;
  messageTs: string;
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
  const profile = slackIdentityFromUserInfo(await client.getUserInfo(slackUserId));
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
  });
}
