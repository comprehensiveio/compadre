import assert from "node:assert/strict";
import test from "node:test";
import {
  configuredAgentProvider,
  retryBackgroundPreemptions,
  validateConversationConfiguration,
} from "./conversation.js";
import { BackgroundCapacityPreemptedError } from "./tanstack/thread-lock.js";

function withEnv(name: string, value: string | undefined, run: () => void): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test("uses Claude Code by default and accepts either harness provider", () => {
  withEnv("COMPADRE_AGENT_PROVIDER", undefined, () => {
    assert.equal(configuredAgentProvider(), "claude-code");
  });
  withEnv("COMPADRE_AGENT_PROVIDER", "codex", () => {
    assert.equal(configuredAgentProvider(), "codex");
  });
  withEnv("COMPADRE_AGENT_PROVIDER", "claude-code", () => {
    assert.equal(configuredAgentProvider(), "claude-code");
  });
});

test("fails fast for an invalid harness provider", () => {
  withEnv("COMPADRE_AGENT_PROVIDER", "other", () => {
    assert.throws(validateConversationConfiguration, /COMPADRE_AGENT_PROVIDER/);
  });
});

test("retries typed background preemption until the task succeeds", async () => {
  let runs = 0;
  const attempts: number[] = [];

  const result = await retryBackgroundPreemptions(
    async () => {
      runs += 1;
      if (runs < 3) throw new BackgroundCapacityPreemptedError();
      return "completed";
    },
    (attempt) => {
      attempts.push(attempt);
    },
  );

  assert.equal(result, "completed");
  assert.equal(runs, 3);
  assert.deepEqual(attempts, [1, 2]);
});

test("does not retry ordinary background failures", async () => {
  let runs = 0;

  await assert.rejects(
    retryBackgroundPreemptions(async () => {
      runs += 1;
      throw new Error("provider failed");
    }),
    /provider failed/,
  );
  assert.equal(runs, 1);
});

test("stops retrying when the caller cancels between attempts", async () => {
  const abortController = new AbortController();
  const cancellation = new Error("caller cancelled");
  let runs = 0;

  await assert.rejects(
    retryBackgroundPreemptions(
      async () => {
        runs += 1;
        throw new BackgroundCapacityPreemptedError();
      },
      () => abortController.abort(cancellation),
      abortController.signal,
    ),
    (error) => error === cancellation,
  );
  assert.equal(runs, 1);
});
