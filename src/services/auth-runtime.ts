import { getConfiguredAgentRunDurability } from "../durability/runtime.js";
import { AuthStore } from "./auth-store.js";

let configuredAuthStore: Promise<AuthStore | null> | undefined;

export function getConfiguredAuthStore(): Promise<AuthStore | null> {
  if (!configuredAuthStore) {
    const initialization = getConfiguredAgentRunDurability()
      .then((durability) =>
        durability?.backend === "postgres" && durability.database
          ? new AuthStore(durability.database)
          : null,
      )
      .catch((error) => {
        if (configuredAuthStore === initialization) configuredAuthStore = undefined;
        throw error;
      });
    configuredAuthStore = initialization;
  }
  return configuredAuthStore;
}

export function resetConfiguredAuthStoreForTests(): void {
  configuredAuthStore = undefined;
}
