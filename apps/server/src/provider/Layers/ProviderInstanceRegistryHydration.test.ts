import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

describe("deriveProviderInstanceConfigMap", () => {
  it("preserves explicitly configured native providers", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        ...DEFAULT_SERVER_SETTINGS.providerInstances,
        codex: {
          driver: ProviderDriverKind.make("codex"),
          displayName: "Explicit Codex",
          config: {},
        },
      },
    };
    const configMap = deriveProviderInstanceConfigMap(settings);

    expect(configMap[ProviderInstanceId.make("codex")]?.displayName).toBe("Explicit Codex");
  });
});
