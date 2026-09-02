const CHANNEL_NAME_CACHE_TTL_MS = 15 * 60 * 1000;

interface CacheEntry {
  name: string;
  expiresAt: number;
}

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  channel?: {
    name?: string;
  };
  user?: {
    name?: string;
    real_name?: string;
    profile?: {
      display_name?: string;
      real_name?: string;
    };
  };
}

interface SlackChannelNameOptions {
  channel: string;
  botToken: string;
  userId?: string;
}

type FetchImplementation = typeof fetch;

const channelNameCache = new Map<string, CacheEntry>();

export async function resolveSlackChannelName(
  options: SlackChannelNameOptions,
): Promise<string | null> {
  const cacheKey = `${options.channel}:${options.userId || ""}`;
  const cached = channelNameCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.name;
  }

  const name = await fetchSlackChannelName(options);
  if (name) {
    channelNameCache.set(cacheKey, {
      name,
      expiresAt: Date.now() + CHANNEL_NAME_CACHE_TTL_MS,
    });
  }
  return name;
}

export async function fetchSlackChannelName(
  { channel, botToken, userId }: SlackChannelNameOptions,
  fetchImplementation: FetchImplementation = fetch,
): Promise<string | null> {
  if (channel.startsWith("D") && userId) {
    const user = await callSlackApi(
      "users.info",
      { user: userId },
      botToken,
      fetchImplementation,
    );
    const displayName =
      user?.user?.profile?.display_name ||
      user?.user?.profile?.real_name ||
      user?.user?.real_name ||
      user?.user?.name;
    return displayName ? `Direct message with ${displayName}` : "Direct message";
  }

  const conversation = await callSlackApi(
    "conversations.info",
    { channel },
    botToken,
    fetchImplementation,
  );
  const name = conversation?.channel?.name;
  return name ? `#${name}` : null;
}

async function callSlackApi(
  method: string,
  params: Record<string, string>,
  botToken: string,
  fetchImplementation: FetchImplementation,
): Promise<SlackApiResponse | null> {
  try {
    const response = await fetchImplementation(
      `https://slack.com/api/${method}?${new URLSearchParams(params)}`,
      {
        headers: { Authorization: `Bearer ${botToken}` },
        signal: AbortSignal.timeout(2_000),
      },
    );
    const data = (await response.json()) as SlackApiResponse;
    if (!data.ok) {
      console.error(`[slack-context] ${method} failed:`, data.error);
      return null;
    }
    return data;
  } catch (error) {
    console.error(`[slack-context] ${method} failed:`, error);
    return null;
  }
}
