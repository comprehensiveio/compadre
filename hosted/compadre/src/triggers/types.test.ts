import assert from "node:assert/strict";
import test from "node:test";
import {
  triggeredPromptInputSchema,
  triggeredPromptScheduleId,
  validateCronExpression,
} from "./types.js";

test("validateCronExpression accepts 5-field expressions and known macros", () => {
  assert.equal(validateCronExpression("0 9 * * 1-5"), undefined);
  assert.equal(validateCronExpression("@daily"), undefined);
  assert.match(validateCronExpression("@fortnightly") ?? "", /Unknown cron macro/);
  assert.match(validateCronExpression("0 9 * *") ?? "", /5 fields/);
  assert.match(validateCronExpression("0 9 * * $") ?? "", /Invalid cron field/);
  assert.match(validateCronExpression("") ?? "", /required/);
});

test("channel delivery modes require a Slack channel and reject thread targets", () => {
  const base = {
    name: "Daily summary",
    prompt: "Summarize yesterday's work",
    cronExpression: "0 9 * * *",
  };
  assert.equal(triggeredPromptInputSchema.safeParse(base).success, false);
  const withChannel = triggeredPromptInputSchema.parse({
    ...base,
    slackChannelId: "C0123456789",
  });
  assert.equal(withChannel.deliveryMode, "new_thread");
  assert.equal(withChannel.enabled, true);
  assert.equal(
    triggeredPromptInputSchema.safeParse({
      ...base,
      slackChannelId: "C0123456789",
      targetThreadId: "6f76f496-6f37-4c4c-9e2f-000000000000",
    }).success,
    false,
  );
});

test("existing_thread requires a thread id UUID and no Slack channel", () => {
  const base = {
    name: "Watch this thread",
    prompt: "Check in",
    cronExpression: "@hourly",
    deliveryMode: "existing_thread",
  };
  assert.equal(triggeredPromptInputSchema.safeParse(base).success, false);
  assert.equal(
    triggeredPromptInputSchema.safeParse({ ...base, targetThreadId: "not-a-uuid" })
      .success,
    false,
  );
  const parsed = triggeredPromptInputSchema.parse({
    ...base,
    targetThreadId: "6f76f496-6f37-4c4c-9e2f-000000000000",
  });
  assert.equal(parsed.slackChannelId, undefined);
});

test("schedule ids are stable per trigger", () => {
  assert.equal(triggeredPromptScheduleId("abc"), "triggered-prompt-abc");
});
