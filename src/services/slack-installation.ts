interface SlackAuthTestResponse {
  ok?: boolean;
  error?: string;
  team_id?: string;
  user_id?: string;
  bot_id?: string;
}

interface SlackBotInfoResponse {
  ok?: boolean;
  error?: string;
  bot?: { app_id?: string };
}

export interface SlackInstallationIdentity {
  workspaceId: string;
  botUserId: string;
  botId?: string;
  appId?: string;
}

/** Prove that the configured token belongs to the one allowed installation. */
export async function validateSlackInstallation(input: {
  botToken: string;
  expectedWorkspaceId: string;
  expectedBotUserId?: string;
  expectedAppId?: string;
  fetchImpl?: typeof fetch;
}): Promise<SlackInstallationIdentity> {
  const response = await (input.fetchImpl ?? fetch)(
    "https://slack.com/api/auth.test",
    { headers: { Authorization: `Bearer ${input.botToken}` } },
  );
  const result = (await response.json()) as SlackAuthTestResponse;
  if (!response.ok || !result.ok) {
    throw new Error(
      `Slack bot token validation failed: ${result.error ?? `HTTP ${response.status}`}`,
    );
  }
  if (!result.team_id || result.team_id !== input.expectedWorkspaceId) {
    throw new Error(
      `Slack bot token belongs to workspace ${result.team_id ?? "unknown"}, expected ${input.expectedWorkspaceId}`,
    );
  }
  if (!result.user_id) {
    throw new Error("Slack auth.test did not return a bot user id");
  }
  if (
    input.expectedBotUserId &&
    result.user_id !== input.expectedBotUserId
  ) {
    throw new Error(
      `Slack bot token belongs to user ${result.user_id}, expected ${input.expectedBotUserId}`,
    );
  }
  let appId: string | undefined;
  if (input.expectedAppId) {
    if (!result.bot_id) {
      throw new Error("Slack auth.test did not return a bot id for app validation");
    }
    const botUrl = new URL("https://slack.com/api/bots.info");
    botUrl.searchParams.set("bot", result.bot_id);
    const botResponse = await (input.fetchImpl ?? fetch)(botUrl, {
      headers: { Authorization: `Bearer ${input.botToken}` },
    });
    const bot = (await botResponse.json()) as SlackBotInfoResponse;
    if (!botResponse.ok || !bot.ok) {
      throw new Error(
        `Slack app validation failed: ${bot.error ?? `HTTP ${botResponse.status}`}`,
      );
    }
    appId = bot.bot?.app_id;
    if (appId !== input.expectedAppId) {
      throw new Error(
        `Slack bot belongs to app ${appId ?? "unknown"}, expected ${input.expectedAppId}`,
      );
    }
  }
  return {
    workspaceId: result.team_id,
    botUserId: result.user_id,
    ...(result.bot_id ? { botId: result.bot_id } : {}),
    ...(appId ? { appId } : {}),
  };
}

export async function validateConfiguredSlackInstallation(
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): Promise<SlackInstallationIdentity | null> {
  const botToken = environment.SLACK_BOT_TOKEN?.trim();
  if (!botToken) return null;
  const expectedWorkspaceId =
    environment.COMPADRE_SLACK_WORKSPACE_ID?.trim();
  if (!expectedWorkspaceId) {
    throw new Error(
      "COMPADRE_SLACK_WORKSPACE_ID is required when SLACK_BOT_TOKEN is configured",
    );
  }
  return validateSlackInstallation({
    botToken,
    expectedWorkspaceId,
    expectedBotUserId: environment.SLACK_BOT_USER_ID?.trim(),
    expectedAppId: environment.COMPADRE_SLACK_APP_ID?.trim(),
    fetchImpl,
  });
}

export function isAllowedSlackApp(input: {
  configuredAppId?: string;
  eventAppId?: string;
}): boolean {
  const configured = input.configuredAppId?.trim();
  return !configured || input.eventAppId === configured;
}
