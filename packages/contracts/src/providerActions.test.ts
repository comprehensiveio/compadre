import * as Schema from "effect/Schema";
import fixtures from "../fixtures/provider-actions.json" with { type: "json" };
import { describe, expect, it } from "vite-plus/test";
import { ProviderAction, providerActionFromText, providerActionPrompt } from "./providerActions.ts";
const isProviderAction = Schema.is(ProviderAction);
const decodeProviderAction = Schema.decodeUnknownSync(ProviderAction);

describe("provider actions", () => {
  it("conforms to the shared wire fixtures", () => {
    for (const value of fixtures.valid) expect(isProviderAction(value)).toBe(true);
    for (const value of fixtures.invalid) expect(isProviderAction(value)).toBe(false);
    for (const { text, action, prompt } of fixtures.commands) {
      expect(providerActionFromText(text)).toEqual(action);
      expect(providerActionPrompt(decodeProviderAction(action))).toBe(prompt);
    }
    for (const text of fixtures.prompts) expect(providerActionFromText(text)).toBeUndefined();
  });
  it("recognizes exact commands without guessing at prose or arbitrary slash commands", () => {
    expect(providerActionFromText(" /compact\n")).toEqual({ type: "compact" });
    for (const text of [
      "Please /compact",
      "/compact some instructions",
      "/unknown",
      "metadata\n/compact",
    ]) {
      expect(providerActionFromText(text)).toBeUndefined();
    }
  });
  it("validates the allowlist and generates the native command", () => {
    expect(providerActionPrompt(decodeProviderAction({ type: "compact" }))).toBe("/compact");
    expect(() => decodeProviderAction({ type: "shell" })).toThrow();
  });
});
