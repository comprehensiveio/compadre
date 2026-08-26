import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { CODEX_MODEL, DEFAULT_MODEL, FABLE_MODEL } from "../config.js";
import {
  CLAUDE_DANGEROUS_PERMISSIONS,
  CODEX_DANGEROUS_PERMISSIONS,
  harnessEnvironment,
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

test("marks Compadre harness startup as dependency-lazy", () => {
  assert.deepEqual(harnessEnvironment("/tmp/worktrees/example", {}), {
    COMPADRE_SKIP_WORKTREE_SETUP: "1",
    GIT_CEILING_DIRECTORIES: "/tmp/worktrees",
    GIT_TERMINAL_PROMPT: "0",
    PATH: "/opt/compadre-runtime/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  });
});

test("gives harness Git commands the same non-persisted GitHub auth", () => {
  const environment = harnessEnvironment("/tmp/worktrees/example", {
    GITHUB_REPO_URL: "https://github.example/owner/repo.git",
    GITHUB_PERSONAL_ACCESS_TOKEN: "secret-token",
    UNRELATED: "not-forwarded",
  });

  assert.equal(environment.GIT_CONFIG_COUNT, "2");
  assert.equal(
    environment.GIT_CONFIG_KEY_0,
    "http.https://github.example/.extraHeader",
  );
  assert.equal(
    environment.GIT_CONFIG_VALUE_0,
    `Authorization: Basic ${Buffer.from("x-access-token:secret-token").toString("base64")}`,
  );
  assert.equal(
    environment.GIT_CONFIG_KEY_1,
    "http.https://github.example/.followRedirects",
  );
  assert.equal(environment.GIT_CONFIG_VALUE_1, "false");
  assert.equal("GITHUB_PERSONAL_ACCESS_TOKEN" in environment, false);
  assert.equal("GITHUB_REPO_URL" in environment, false);
  assert.equal("UNRELATED" in environment, false);
  assert.equal(
    JSON.stringify(environment).includes("secret-token"),
    false,
  );
});

test("gives a remote harness only its selected model credential", () => {
  const environment = harnessEnvironment("/workspace", {
    ANTHROPIC_API_KEY: "anthropic-secret",
    CODEX_API_KEY: "codex-secret",
  }, "claude-code");
  assert.equal(environment.ANTHROPIC_API_KEY, "anthropic-secret");
  assert.equal(environment.CODEX_API_KEY, undefined);

  const codexEnvironment = harnessEnvironment("/workspace", {
    ANTHROPIC_API_KEY: "anthropic-secret",
    CODEX_API_KEY: "codex-secret",
  }, "codex");
  assert.equal(codexEnvironment.CODEX_API_KEY, "codex-secret");
  assert.equal(codexEnvironment.ANTHROPIC_API_KEY, undefined);
});

test("exposes the pinned harness CLIs to sandbox shell commands", () => {
  const environment = harnessEnvironment("/workspace", {
    COMPADRE_MODAL_CLI_ROOT: "/custom/runtime",
  });
  assert.equal(
    environment.PATH,
    "/custom/runtime/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  );

  const customImageEnvironment = harnessEnvironment("/workspace", {
    COMPADRE_MODAL_SKIP_CLI_SETUP: "true",
  });
  assert.equal(customImageEnvironment.PATH, undefined);
});
