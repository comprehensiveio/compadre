import assert from "node:assert/strict";
import test from "node:test";
import {
  configuredAgentProvider,
  configuredConversationRuntime,
  conversationRuntimeForSlackUser,
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

test("keeps the legacy runtime as the rollout default", () => {
  withEnv("COMPADRE_AGENT_RUNTIME", undefined, () => {
    assert.equal(configuredConversationRuntime(), "legacy");
  });
  withEnv("COMPADRE_AGENT_RUNTIME", "unknown", () => {
    assert.equal(configuredConversationRuntime(), "legacy");
  });
});

test("opts into TanStack and selects either configured harness", () => {
  withEnv("COMPADRE_AGENT_RUNTIME", "tanstack", () => {
    assert.equal(configuredConversationRuntime(), "tanstack");
  });
  withEnv("COMPADRE_AGENT_PROVIDER", "codex", () => {
    assert.equal(configuredAgentProvider(), "codex");
  });
  withEnv("COMPADRE_AGENT_PROVIDER", "claude-code", () => {
    assert.equal(configuredAgentProvider(), "claude-code");
  });
});

test("falls back to Claude when the configured provider is invalid", () => {
  withEnv("COMPADRE_AGENT_PROVIDER", "other", () => {
    assert.equal(configuredAgentProvider(), "claude-code");
  });
});

test("fails fast for invalid rollout configuration", () => {
  withEnv("COMPADRE_AGENT_RUNTIME", "other", () => {
    assert.throws(validateConversationConfiguration, /COMPADRE_AGENT_RUNTIME/);
  });
  withEnv("COMPADRE_AGENT_RUNTIME", "tanstack", () => {
    withEnv("COMPADRE_AGENT_PROVIDER", "other", () => {
      assert.throws(validateConversationConfiguration, /COMPADRE_AGENT_PROVIDER/);
    });
  });
  withEnv("COMPADRE_AGENT_RUNTIME", "legacy", () => {
    withEnv("COMPADRE_TANSTACK_SLACK_USER_IDS", "U-CANARY", () => {
      withEnv("COMPADRE_AGENT_PROVIDER", "other", () => {
        assert.throws(
          validateConversationConfiguration,
          /COMPADRE_AGENT_PROVIDER/
        );
      });
    });
  });
});

test("routes only allowlisted Slack users through TanStack", () => {
  withEnv("COMPADRE_AGENT_RUNTIME", "legacy", () => {
    withEnv("COMPADRE_TANSTACK_SLACK_USER_IDS", "U-CANARY-1, U-CANARY-2", () => {
      assert.equal(conversationRuntimeForSlackUser("U-CANARY-2"), "tanstack");
      assert.equal(conversationRuntimeForSlackUser("U-OTHER"), "legacy");
      assert.equal(conversationRuntimeForSlackUser(undefined), "legacy");
    });
  });
});

test("uses the global Slack runtime when no canary allowlist is configured", () => {
  withEnv("COMPADRE_AGENT_RUNTIME", "tanstack", () => {
    withEnv("COMPADRE_TANSTACK_SLACK_USER_IDS", undefined, () => {
      assert.equal(conversationRuntimeForSlackUser("U-ANY"), "tanstack");
    });
  });
});

test("keeps non-canary Slack users on legacy during a global TanStack rollout", () => {
  withEnv("COMPADRE_AGENT_RUNTIME", "tanstack", () => {
    withEnv("COMPADRE_TANSTACK_SLACK_USER_IDS", "U-CANARY", () => {
      assert.equal(conversationRuntimeForSlackUser("U-OTHER"), "legacy");
    });
  });
});
