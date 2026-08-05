import assert from "node:assert/strict";
import test from "node:test";
import {
  configuredAgentProvider,
  validateConversationConfiguration,
} from "./conversation.js";

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
