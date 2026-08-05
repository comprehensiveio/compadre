import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { CODEX_MODEL, DEFAULT_MODEL, FABLE_MODEL } from "../config.js";
import {
  CLAUDE_DANGEROUS_PERMISSIONS,
  CODEX_DANGEROUS_PERMISSIONS,
  resolveHarnessSelection,
} from "./harness.js";

const originalProvider = process.env.COMPADRE_AGENT_PROVIDER;

afterEach(() => {
  if (originalProvider === undefined) {
    delete process.env.COMPADRE_AGENT_PROVIDER;
  } else {
    process.env.COMPADRE_AGENT_PROVIDER = originalProvider;
  }
});

test("defaults to the Claude Code harness", () => {
  delete process.env.COMPADRE_AGENT_PROVIDER;
  assert.deepEqual(resolveHarnessSelection({}), {
    provider: "claude-code",
    model: DEFAULT_MODEL,
  });
});

test("selects Codex globally or per AG-UI request", () => {
  process.env.COMPADRE_AGENT_PROVIDER = "codex";
  assert.equal(resolveHarnessSelection({}).provider, "codex");
  assert.deepEqual(
    resolveHarnessSelection({ provider: "codex" }),
    {
      provider: "codex",
      model: CODEX_MODEL,
    },
  );
});

test("selects Fable only through an explicit profile", () => {
  process.env.COMPADRE_AGENT_PROVIDER = "codex";
  assert.deepEqual(resolveHarnessSelection({ profile: "fable" }), {
    provider: "claude-code",
    model: FABLE_MODEL,
  });
});

test("explicit Codex and Claude Code profiles override the configured default", () => {
  process.env.COMPADRE_AGENT_PROVIDER = "claude-code";
  assert.deepEqual(resolveHarnessSelection({ profile: "codex" }), {
    provider: "codex",
    model: CODEX_MODEL,
  });

  process.env.COMPADRE_AGENT_PROVIDER = "codex";
  assert.deepEqual(resolveHarnessSelection({ profile: "claude-code" }), {
    provider: "claude-code",
    model: DEFAULT_MODEL,
  });
});

test("rejects arbitrary model overrides", () => {
  assert.equal(
    resolveHarnessSelection({
      provider: "codex",
      model: "surprise-model",
    }).model,
    CODEX_MODEL,
  );
});

test("runs both coding harnesses without tool approval gates", () => {
  assert.deepEqual(CODEX_DANGEROUS_PERMISSIONS, {
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
    config: {
      "mcp_servers.tanstack.default_tools_approval_mode": '"approve"',
    },
  });
  assert.deepEqual(CLAUDE_DANGEROUS_PERMISSIONS, {
    permissionMode: "bypassPermissions",
  });
  assert.equal("allowedTools" in CLAUDE_DANGEROUS_PERMISSIONS, false);
});
