export interface SlackAgentInputOptions {
  messageText: string;
  threadContext: string | null;
  channel: string;
  channelName: string | null;
  threadTs: string;
  userId?: string;
}

export interface SlackAgentInput {
  prompt: string;
  transcriptUserMessage: string;
}

function buildSlackThreadUrl(channel: string, threadTs: string): string {
  return `https://comprehensiveio.slack.com/archives/${channel}/p${threadTs.replace(".", "")}`;
}

/** Build channel metadata for the harness without polluting neutral history. */
export function buildSlackAgentInput({
  messageText,
  threadContext,
  channel,
  channelName,
  threadTs,
  userId,
}: SlackAgentInputOptions): SlackAgentInput {
  const promptParts = ["User query:", messageText];
  if (threadContext) {
    promptParts.push(
      "",
      "Thread context (prior messages in this thread):",
      threadContext
    );
  }
  promptParts.push(
    "",
    `Slack message from user ${userId || "unknown"}.`,
    "",
    "Reply to:",
    `- channel: ${channel}`,
    ...(channelName ? [`- channel_name: ${channelName}`] : []),
    `- thread_ts: ${threadTs} (reply in this thread)`,
    `- slack_thread_url: ${buildSlackThreadUrl(channel, threadTs)}`
  );
  return {
    prompt: promptParts.join("\n"),
    transcriptUserMessage: messageText,
  };
}
