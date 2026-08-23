import assert from "node:assert/strict";
import test from "node:test";
import { EventType, type StreamChunk } from "@tanstack/ai";
import {
  guardBackgroundPreemption,
  messagesWithAttachmentPrompt,
  messagesForHarnessSession,
} from "./runtime.js";
import {
  BackgroundCapacityPreemptedError,
  type ThreadRunLease,
} from "./thread-lock.js";

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

test("preserves typed preemption when an aborted provider ends silently", async () => {
  const abortController = new AbortController();
  const lease: ThreadRunLease = {
    signal: abortController.signal,
    release: async () => undefined,
  };
  async function* interrupted(): AsyncIterable<StreamChunk> {
    abortController.abort(new BackgroundCapacityPreemptedError());
  }

  await assert.rejects(
    async () => {
      for await (const _chunk of guardBackgroundPreemption(
        interrupted(),
        lease,
      )) {
        // No chunks are expected.
      }
    },
    BackgroundCapacityPreemptedError,
  );
});

test("does not retry a run that completed before background preemption", async () => {
  const abortController = new AbortController();
  const lease: ThreadRunLease = {
    signal: abortController.signal,
    release: async () => undefined,
  };
  const finished: StreamChunk = {
    type: EventType.RUN_FINISHED,
    timestamp: 1,
    threadId: "thread",
    runId: "run",
  };
  async function* completed(): AsyncIterable<StreamChunk> {
    yield finished;
    abortController.abort(new BackgroundCapacityPreemptedError());
  }
  const chunks: StreamChunk[] = [];

  for await (const chunk of guardBackgroundPreemption(completed(), lease)) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, [finished]);
});
