import type { AgentProfile } from "../tanstack/protocol.js";

const DIRECTIVE_PATTERN =
  /(?<!\S)--(sol|codex|fable|claude-code|cc)(?=\s|$)/gi;

const PROFILE_BY_DIRECTIVE: Record<string, AgentProfile> = {
  sol: "codex",
  codex: "codex",
  fable: "fable",
  "claude-code": "claude-code",
  cc: "claude-code",
};

export type AgentRouteDirectiveResult =
  | {
      ok: true;
      messageText: string;
      profile?: AgentProfile;
    }
  | {
      ok: false;
      error: string;
    };

/**
 * Parse stable, one-turn agent aliases from a user message. The directive is
 * removed before the prompt or provider-neutral transcript is created.
 */
export function parseAgentRouteDirective(
  messageText: string,
): AgentRouteDirectiveResult {
  const profiles = new Set<AgentProfile>();
  for (const match of messageText.matchAll(DIRECTIVE_PATTERN)) {
    profiles.add(PROFILE_BY_DIRECTIVE[match[1].toLowerCase()]);
  }

  if (profiles.size > 1) {
    return {
      ok: false,
      error:
        "Choose one agent route: --sol/--codex, --fable, or --claude-code/--cc.",
    };
  }

  const cleanedMessage = messageText
    .replace(DIRECTIVE_PATTERN, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (profiles.size === 1 && !cleanedMessage) {
    return {
      ok: false,
      error: "Add a request alongside the agent routing directive.",
    };
  }

  const profile = profiles.values().next().value;
  return {
    ok: true,
    messageText: cleanedMessage,
    ...(profile ? { profile } : {}),
  };
}
