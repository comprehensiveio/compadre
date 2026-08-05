import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { CODEX_MODEL, DEFAULT_MODEL, FABLE_MODEL } from "../config.js";
import {
  CLAUDE_DANGEROUS_PERMISSIONS,
  CODEX_DANGEROUS_PERMISSIONS,
  cleanFableControlText,
  messagesWithoutFableFlag,
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

const userMessages = (content: string) => [
  { id: "message-1", role: "user" as const, content },
];

test("defaults to the Claude Code harness", () => {
  delete process.env.COMPADRE_AGENT_PROVIDER;
  assert.deepEqual(resolveHarnessSelection({}, userMessages("hello")), {
    provider: "claude-code",
    model: DEFAULT_MODEL,
    sessionEvent: "claude-code.session-id",
  });
});

test("selects Codex globally or per AG-UI request", () => {
  process.env.COMPADRE_AGENT_PROVIDER = "codex";
  assert.equal(
    resolveHarnessSelection({}, userMessages("hello")).provider,
    "codex"
  );
  assert.deepEqual(
    resolveHarnessSelection(
      { provider: "codex" },
      userMessages("hello --fable")
    ),
    {
      provider: "codex",
      model: CODEX_MODEL,
      sessionEvent: "codex.session-id",
    }
  );
});

test("keeps the existing Fable selection on the Claude harness", () => {
  const messages = userMessages("investigate --fable\n\n\nnow");
  assert.equal(
    resolveHarnessSelection({}, messages).model,
    FABLE_MODEL
  );
  assert.deepEqual(messagesWithoutFableFlag(messages), [
    { id: "message-1", role: "user", content: "investigate\n\nnow" },
  ]);
  assert.equal(messages[0].content, "investigate --fable\n\n\nnow");
});

test("does not turn a Fable-only prompt into an empty message", () => {
  assert.equal(cleanFableControlText("--fable"), "--fable");
});

test("rejects arbitrary model overrides", () => {
  assert.equal(
    resolveHarnessSelection(
      { provider: "codex", model: "surprise-model" },
      userMessages("hello")
    ).model,
    CODEX_MODEL
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
