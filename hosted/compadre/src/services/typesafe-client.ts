import { TypeSafeClient } from "@typesafe-ai/sdk";
import { log } from "../logging.js";

export const TYPESAFE_MODEL = "jev-latest";
const TYPESAFE_TIMEOUT_MS = 8_000;

let cached: TypeSafeClient | null | undefined;
let warned = false;

/**
 * One TypeSafe (Jev) client per process for every controller-side judgement.
 * Null when TYPESAFE_API_KEY is absent so each caller degrades to its "off"
 * behavior instead of failing ingress or delivery.
 */
export function configuredTypeSafeClient(
  environment: NodeJS.ProcessEnv = process.env,
): TypeSafeClient | null {
  if (cached !== undefined) return cached;
  const apiKey = environment.TYPESAFE_API_KEY?.trim();
  if (!apiKey) {
    if (!warned) {
      warned = true;
      log.warn({}, "typesafe judgements disabled; TYPESAFE_API_KEY is not configured");
    }
    cached = null;
    return cached;
  }
  cached = new TypeSafeClient({
    apiKey,
    defaultModel: TYPESAFE_MODEL,
    timeout: TYPESAFE_TIMEOUT_MS,
    logLevel: "off",
  });
  return cached;
}

export function resetConfiguredTypeSafeClientForTests(): void {
  cached = undefined;
  warned = false;
}
