import * as Schema from "effect/Schema";

/** Harness operations, never conversational prompts. Add actions here deliberately. */
export const ProviderAction = Schema.Struct({ type: Schema.Literal("compact") });
export type ProviderAction = typeof ProviderAction.Type;

export const PROVIDER_ACTIONS = {
  compact: { command: "/compact", driverKind: "claudeAgent", label: "Compact context" },
} as const;

/** Exact commands from older clients use the same typed path as action buttons. */
export function providerActionFromText(text: string): ProviderAction | undefined {
  return text.trim() === PROVIDER_ACTIONS.compact.command ? { type: "compact" } : undefined;
}

export function providerActionPrompt(action: ProviderAction): string {
  return PROVIDER_ACTIONS[action.type].command;
}
