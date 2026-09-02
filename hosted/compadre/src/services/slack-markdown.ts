export const SLACK_MARKDOWN_TEXT_LIMIT = 12_000;
export const SLACK_TRUNCATION_NOTICE =
  "\n\n_Response truncated because it exceeded Slack's 12,000-character limit._";

export const SLACK_STREAM_CONTENT_LIMIT =
  SLACK_MARKDOWN_TEXT_LIMIT - SLACK_TRUNCATION_NOTICE.length;

export function truncateSlackMarkdown(text: string): string {
  if (text.length <= SLACK_MARKDOWN_TEXT_LIMIT) return text;
  return (
    text.slice(0, SLACK_STREAM_CONTENT_LIMIT) + SLACK_TRUNCATION_NOTICE
  );
}

/** A link rendered as a small context footer inside an answer message. */
export interface SlackSessionLink {
  label: string;
  url: string;
}

/**
 * chat.postMessage content for one markdown message. With a session link the
 * link rides inside the answer message as a small context footer; the native
 * `markdown` block keeps the answer's rendering identical to plain
 * markdown_text, and the `text` fallback carries both for notifications.
 */
export function slackMarkdownMessageContent(
  markdown: string,
  sessionLink?: SlackSessionLink,
): Record<string, unknown> {
  const text = truncateSlackMarkdown(markdown);
  if (!sessionLink) return { markdown_text: text };
  return {
    text: `${text}\n\n${sessionLink.label}: ${sessionLink.url}`,
    blocks: [
      { type: "markdown", text },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `<${sessionLink.url}|${sessionLink.label}>`,
          },
        ],
      },
    ],
    unfurl_links: false,
    unfurl_media: false,
  };
}
