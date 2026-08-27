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
    "Slack response contract:",
    "- Compadre automatically posts only your final assistant message to this Slack thread after the run completes.",
    "- Working narration and tool-call text remain in the web UI and are not sent to Slack.",
    "- End with one concise, self-contained final answer suitable for a Slack thread.",
    "- Do not use slack_post_message or slack_reply_to_thread to deliver or duplicate that final answer in this thread.",
    "- Slack read tools, file uploads, reactions, and durable deployment watches remain available when the task actually requires them.",
    "- Use the channel name only as ambient context; prioritize the user's message and thread history.",
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
