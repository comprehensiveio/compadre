import type { chat } from "@tanstack/ai";

export const AGENT_PROVIDERS = ["claude-code", "codex"] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export interface AguiChatParams {
  messages: NonNullable<Parameters<typeof chat>[0]["messages"]>;
  threadId: string;
  runId: string;
  parentRunId?: string;
  tools: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
  forwardedProps: Record<string, unknown>;
  state: unknown;
  resume?: Array<{
    interruptId: string;
    status: "resolved" | "cancelled";
    payload?: unknown;
  }>;
}

export function isAgentProvider(value: unknown): value is AgentProvider {
  return AGENT_PROVIDERS.includes(value as AgentProvider);
}
