import {
  EventType,
  type StreamChunk,
  type chatParamsFromRequestBody,
} from "@tanstack/ai";

export const AGENT_PROVIDERS = ["claude-code", "codex"] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export const AGENT_PROFILES = ["claude-code", "codex", "fable"] as const;
export type AgentProfile = (typeof AGENT_PROFILES)[number];

export type AguiChatParams = Awaited<
  ReturnType<typeof chatParamsFromRequestBody>
>;

export function isAgentProvider(value: unknown): value is AgentProvider {
  return AGENT_PROVIDERS.includes(value as AgentProvider);
}

export function isAgentProfile(value: unknown): value is AgentProfile {
  return AGENT_PROFILES.includes(value as AgentProfile);
}

export function providerForAgentProfile(profile: AgentProfile): AgentProvider {
  return profile === "codex" ? "codex" : "claude-code";
}

export function configuredAgentProvider(): AgentProvider {
  return isAgentProvider(process.env.COMPADRE_AGENT_PROVIDER)
    ? process.env.COMPADRE_AGENT_PROVIDER
    : "claude-code";
}

export function validateAgentProviderConfiguration(): {
  provider: AgentProvider;
} {
  const configuredProvider = process.env.COMPADRE_AGENT_PROVIDER;
  if (
    configuredProvider !== undefined &&
    !isAgentProvider(configuredProvider)
  ) {
    throw new Error(
      "COMPADRE_AGENT_PROVIDER must be 'claude-code' or 'codex'"
    );
  }
  return { provider: configuredAgentProvider() };
}

const SESSION_EVENTS: Record<AgentProvider, string> = {
  "claude-code": "claude-code.session-id",
  codex: "codex.session-id",
};

export function sessionIdFromChunk(
  chunk: StreamChunk,
  provider: AgentProvider
): string | undefined {
  if (
    chunk.type !== EventType.CUSTOM ||
    chunk.name !== SESSION_EVENTS[provider] ||
    typeof chunk.value !== "object" ||
    chunk.value === null
  ) {
    return undefined;
  }
  const sessionId = (chunk.value as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" ? sessionId : undefined;
}
