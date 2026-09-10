import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { z } from "zod";
import { PROVIDER_ACTIONS, providerActionFromText, providerActionSchema } from "./provider-actions.js";

test("controller conforms to the shared provider-action wire fixtures", () => {
  const fixture = z.object({
    valid: z.array(z.unknown()), invalid: z.array(z.unknown()), prompts: z.array(z.string()),
    commands: z.array(z.object({ text: z.string(), action: providerActionSchema, prompt: z.string() })),
  }).parse(JSON.parse(readFileSync(new URL("../../../../packages/contracts/fixtures/provider-actions.json", import.meta.url), "utf8")));
  for (const value of fixture.valid) assert.equal(providerActionSchema.safeParse(value).success, true);
  for (const value of fixture.invalid) assert.equal(providerActionSchema.safeParse(value).success, false);
  for (const { text, action, prompt } of fixture.commands) {
    assert.deepEqual(providerActionFromText(text), action);
    assert.equal(PROVIDER_ACTIONS[action.type].command, prompt);
  }
  for (const text of fixture.prompts) assert.equal(providerActionFromText(text), undefined);
});
