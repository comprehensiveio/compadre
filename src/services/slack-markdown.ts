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
