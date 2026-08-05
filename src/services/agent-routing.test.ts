import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentRouteDirective } from "./agent-routing.js";

const aliases = [
  ["--sol", "codex"],
  ["--codex", "codex"],
  ["--fable", "fable"],
  ["--claude-code", "claude-code"],
  ["--cc", "claude-code"],
] as const;

for (const [directive, profile] of aliases) {
  test(`${directive} selects ${profile} for one turn and is stripped`, () => {
    assert.deepEqual(
      parseAgentRouteDirective(`Please investigate ${directive}`),
      {
        ok: true,
        messageText: "Please investigate",
        profile,
      },
    );
  });
}

test("a message without a directive uses the configured default", () => {
  assert.deepEqual(parseAgentRouteDirective("Please investigate"), {
    ok: true,
    messageText: "Please investigate",
  });
});

test("aliases for the same profile are redundant rather than conflicting", () => {
  assert.deepEqual(
    parseAgentRouteDirective("--sol Please investigate --codex"),
    {
      ok: true,
      messageText: "Please investigate",
      profile: "codex",
    },
  );
});

test("conflicting profiles are rejected", () => {
  assert.deepEqual(
    parseAgentRouteDirective("Please investigate --sol --fable"),
    {
      ok: false,
      error:
        "Choose one agent route: --sol/--codex, --fable, or --claude-code/--cc.",
    },
  );
});

test("a directive without a request is rejected", () => {
  assert.deepEqual(parseAgentRouteDirective("--cc"), {
    ok: false,
    error: "Add a request alongside the agent routing directive.",
  });
});

test("directive-like text inside another token is preserved", () => {
  assert.deepEqual(
    parseAgentRouteDirective("Compare --codex-like behavior and x--fable"),
    {
      ok: true,
      messageText: "Compare --codex-like behavior and x--fable",
    },
  );
});

test("directives are case-insensitive and preserve paragraph breaks", () => {
  assert.deepEqual(
    parseAgentRouteDirective("--FABLE\n\nInvestigate this\ncarefully"),
    {
      ok: true,
      messageText: "Investigate this\ncarefully",
      profile: "fable",
    },
  );
});
