import assert from "node:assert/strict";
import test from "node:test";
import type { StreamChunk } from "@tanstack/ai";
import {
  messagesWithAttachmentPrompt,
  messagesForHarnessSession,
  shouldReuseThreadSandbox,
} from "./runtime.js";

test("adds materialized Slack images to the active user prompt", () => {
  assert.deepEqual(
    messagesWithAttachmentPrompt(
      [{ role: "user", content: "what is this?" }],
      "Slack attachment F123 is available at /repo/.compadre-attachments/image.png.",
    ),
    [
      {
        role: "user",
        content:
          "what is this?\n\nSlack attachment F123 is available at /repo/.compadre-attachments/image.png.",
      },
    ],
  );
});

test("replays the neutral transcript only when starting a fresh provider session", () => {
  const transcript = [
    { role: "user" as const, content: "first request" },
    { role: "assistant" as const, content: "first response" },
  ];
  const current = [{ role: "user" as const, content: "follow-up" }];

  assert.deepEqual(
    messagesForHarnessSession(current, transcript, undefined),
    [...transcript, ...current]
  );
  assert.deepEqual(
    messagesForHarnessSession(current, transcript, "native-session"),
    current
  );
});

test("does not retain a sandbox without a persistent instance store", () => {
  assert.equal(shouldReuseThreadSandbox(null), false);
});
