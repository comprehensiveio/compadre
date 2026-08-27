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

export function buildSlackThreadUrl(channel: string, threadTs: string): string {
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
      threadContext,
    );
  }
  promptParts.push(
    "",
    `Slack message from user ${userId || "unknown"}.`,
    "",
    "Delivery contract:",
    "- Your ordinary assistant output is automatically streamed back to this Slack thread.",
    "- Do not use a Slack tool to duplicate that response in this same thread.",
    "- Use Slack tools only when the user explicitly requests a separate Slack action.",
    "",
    "Automatic delivery destination:",
    `- channel: ${channel}`,
    ...(channelName ? [`- channel_name: ${channelName}`] : []),
    `- thread_ts: ${threadTs} (reply in this thread)`,
    `- slack_thread_url: ${buildSlackThreadUrl(channel, threadTs)}`,
  );
  return {
    prompt: promptParts.join("\n"),
    transcriptUserMessage: messageText,
  };
}
