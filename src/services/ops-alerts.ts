import { truncateSlackMarkdown } from "./slack-markdown.js";

const SLACK_API = "https://slack.com/api";
const ENG_OPS_CHANNEL_ID = "C0B4Z6252M6";
const DATADOG_AUTH_ALERT_INTERVAL_MS = 24 * 60 * 60 * 1000;

let lastDatadogAuthAlertAt = 0;

export async function alertDatadogRefreshTokenInvalid(
  errorDetail?: string
): Promise<void> {
  const now = Date.now();
  if (now - lastDatadogAuthAlertAt < DATADOG_AUTH_ALERT_INTERVAL_MS) {
    return;
  }
  lastDatadogAuthAlertAt = now;

  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    console.error(
      "[ops-alerts] cannot send Datadog auth alert: SLACK_BOT_TOKEN is not configured"
    );
    return;
  }

  const text = buildDatadogRefreshTokenInvalidAlert(errorDetail, new Date(now));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(`${SLACK_API}/chat.postMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({
        channel: ENG_OPS_CHANNEL_ID,
        markdown_text: text,
        unfurl_links: false,
        unfurl_media: false,
      }),
      signal: controller.signal,
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!data.ok) {
      console.error("[ops-alerts] Datadog auth alert failed:", data.error);
    }
  } catch (err) {
    console.error("[ops-alerts] Datadog auth alert error:", err);
  } finally {
    clearTimeout(timeoutId);
  }
}

export function buildDatadogRefreshTokenInvalidAlert(
  errorDetail?: string,
  detectedAt: Date = new Date(),
): string {
  return truncateSlackMarkdown([
    "Compadre needs a new Datadog MCP refresh token.",
    "",
    "Datadog returned `invalid_grant` while Compadre was refreshing the MCP OAuth token. Datadog MCP tools are disabled until `DATADOG_MCP_CLIENT_ID` and `DATADOG_MCP_REFRESH_TOKEN` are updated in Render and the service is restarted.",
    "",
    `Detected at: ${detectedAt.toISOString()}`,
    ...(errorDetail ? ["", `Datadog response: ${errorDetail}`] : []),
  ].join("\n"));
}
