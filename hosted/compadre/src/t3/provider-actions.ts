import { z } from "zod";

// Wire counterpart of packages/contracts/src/providerActions.ts. Keep the
// allowlist explicit: arbitrary slash commands are not provider actions.
export const providerActionSchema = z.object({ type: z.literal("compact") }).strict();
export type ProviderAction = z.infer<typeof providerActionSchema>;
export const PROVIDER_ACTIONS = {
  compact: { command: "/compact", provider: "claude-code" },
} as const;

export function providerActionFromText(text: string): ProviderAction | undefined {
  return text.trim() === PROVIDER_ACTIONS.compact.command ? { type: "compact" } : undefined;
}

export class ProviderActionsUnavailableError extends Error {
  constructor() {
    super("This worker does not support the requested provider action. Update the worker image and retry.");
    this.name = "ProviderActionsUnavailableError";
  }
}
