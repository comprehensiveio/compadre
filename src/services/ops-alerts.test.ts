import assert from "node:assert/strict";
import test from "node:test";
import { buildDatadogRefreshTokenInvalidAlert } from "./ops-alerts.js";
import {
  SLACK_MARKDOWN_TEXT_LIMIT,
  SLACK_TRUNCATION_NOTICE,
} from "./slack-markdown.js";

test("bounds oversized Datadog error details for Slack", () => {
  const message = buildDatadogRefreshTokenInvalidAlert(
    "x".repeat(SLACK_MARKDOWN_TEXT_LIMIT * 2),
    new Date("2026-08-01T12:00:00.000Z"),
  );

  assert.equal(message.length, SLACK_MARKDOWN_TEXT_LIMIT);
  assert.match(message, /Compadre needs a new Datadog MCP refresh token/);
  assert.match(message, /Detected at: 2026-08-01T12:00:00.000Z/);
  assert.ok(message.endsWith(SLACK_TRUNCATION_NOTICE));
});
