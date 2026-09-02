import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_TRIGGERED_PROMPT_DRAFT,
  draftToRequestBody,
  parseCompadreThreadId,
  recordToDraft,
  validateCronExpression,
  validateTriggeredPromptDraft,
  type TriggeredPromptRecord,
} from "./TriggeredPromptsSettings.logic";

const THREAD_ID = "ce09f30d-2e80-5aba-8ee4-77a96b0699e4";
const THREAD_URL = `https://compadre.comprehensive.io/315c28c0-659e-4aa5-8318-aeffc833f303/${THREAD_ID}`;

const VALID_DRAFT = {
  ...EMPTY_TRIGGERED_PROMPT_DRAFT,
  name: "Daily summary",
  prompt: "Summarize yesterday's merged PRs.",
  cronExpression: "0 9 * * 1-5",
  slackChannelId: "C0123456789",
};

describe("validateCronExpression", () => {
  it("accepts 5-field expressions and macros", () => {
    expect(validateCronExpression("0 9 * * 1-5")).toBeNull();
    expect(validateCronExpression("*/15 * * * *")).toBeNull();
    expect(validateCronExpression("@daily")).toBeNull();
  });

  it("rejects malformed expressions", () => {
    expect(validateCronExpression("")).toMatch(/required/u);
    expect(validateCronExpression("0 9 * *")).toMatch(/5 fields/u);
    expect(validateCronExpression("@sometimes")).toMatch(/Unknown cron macro/u);
    expect(validateCronExpression("0 9 * * $")).toMatch(/Invalid cron field/u);
  });
});

describe("parseCompadreThreadId", () => {
  it("extracts the thread id from a Compadre thread URL", () => {
    // The environment id comes first in the URL, so the last UUID wins.
    expect(parseCompadreThreadId(THREAD_URL)).toBe(THREAD_ID);
  });

  it("accepts a bare thread id and normalizes case", () => {
    expect(parseCompadreThreadId(` ${THREAD_ID.toUpperCase()} `)).toBe(THREAD_ID);
  });

  it("returns null for input without a UUID", () => {
    expect(parseCompadreThreadId("not a thread")).toBeNull();
    expect(parseCompadreThreadId("")).toBeNull();
  });
});

describe("validateTriggeredPromptDraft", () => {
  it("accepts a complete new-thread draft", () => {
    expect(validateTriggeredPromptDraft(VALID_DRAFT)).toBeNull();
  });

  it("requires a parseable Compadre thread only for existing-thread delivery", () => {
    expect(
      validateTriggeredPromptDraft({ ...VALID_DRAFT, deliveryMode: "existing_thread" }),
    ).toMatch(/thread/u);
    expect(
      validateTriggeredPromptDraft({
        ...VALID_DRAFT,
        deliveryMode: "existing_thread",
        targetThread: THREAD_URL,
      }),
    ).toBeNull();
  });

  it("does not require a Slack channel for existing-thread delivery", () => {
    expect(
      validateTriggeredPromptDraft({
        ...VALID_DRAFT,
        deliveryMode: "existing_thread",
        slackChannelId: "",
        targetThread: THREAD_ID,
      }),
    ).toBeNull();
  });

  it("rejects malformed channel ids for thread-creating modes", () => {
    expect(validateTriggeredPromptDraft({ ...VALID_DRAFT, slackChannelId: "general" })).toMatch(
      /channel ID/u,
    );
  });
});

describe("draftToRequestBody", () => {
  it("trims fields and omits empty optionals", () => {
    const body = draftToRequestBody({
      ...VALID_DRAFT,
      name: "  Daily summary  ",
      timezone: "",
    });
    expect(body).toEqual({
      name: "Daily summary",
      prompt: "Summarize yesterday's merged PRs.",
      cronExpression: "0 9 * * 1-5",
      deliveryMode: "new_thread",
      slackChannelId: "C0123456789",
      enabled: true,
    });
  });

  it("sends the parsed thread id instead of a channel for existing-thread delivery", () => {
    const body = draftToRequestBody({
      ...VALID_DRAFT,
      deliveryMode: "existing_thread",
      targetThread: THREAD_URL,
    });
    expect(body).toMatchObject({ targetThreadId: THREAD_ID });
    expect(body).not.toHaveProperty("slackChannelId");
  });
});

describe("recordToDraft", () => {
  it("round-trips a record into an editable draft", () => {
    const record: TriggeredPromptRecord = {
      id: "5b5a0f1e-1111-4222-8333-444455556666",
      name: "Weekly digest",
      prompt: "Write the weekly digest.",
      triggerType: "cron",
      triggerConfig: { cronExpression: "0 9 * * 1", timezone: "America/Chicago" },
      deliveryMode: "existing_thread",
      targetThreadId: THREAD_ID,
      enabled: true,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    expect(recordToDraft(record)).toEqual({
      name: "Weekly digest",
      prompt: "Write the weekly digest.",
      cronExpression: "0 9 * * 1",
      timezone: "America/Chicago",
      deliveryMode: "existing_thread",
      slackChannelId: "",
      targetThread: THREAD_ID,
    });
  });
});
