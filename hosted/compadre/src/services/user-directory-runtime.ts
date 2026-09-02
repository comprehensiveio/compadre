import { getConfiguredAgentRunDurability } from "../durability/runtime.js";
import { UserDirectory } from "./user-directory.js";

let configuredDirectory: Promise<UserDirectory | null> | undefined;

/** User identity is available only with the central PostgreSQL backend. */
export function getConfiguredUserDirectory(): Promise<UserDirectory | null> {
  if (!configuredDirectory) {
    const initialization = getConfiguredAgentRunDurability()
      .then((durability) =>
        durability?.backend === "postgres" && durability.database
          ? new UserDirectory(durability.database)
          : null,
      )
      .catch((error) => {
        if (configuredDirectory === initialization) configuredDirectory = undefined;
        throw error;
      });
    configuredDirectory = initialization;
  }
  return configuredDirectory;
}

export function resetConfiguredUserDirectoryForTests(): void {
  configuredDirectory = undefined;
}
