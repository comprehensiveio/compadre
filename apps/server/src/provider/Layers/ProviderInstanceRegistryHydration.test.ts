import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

describe("deriveProviderInstanceConfigMap", () => {
  it("bootstraps Compadre as its own provider when the hosted endpoint is configured", () => {
    const configMap = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS, {
      COMPADRE_PROVIDER_URL: "https://compadre.example/hosted/chat",
    });

    const compadre = configMap[ProviderInstanceId.make("compadre")];
    expect(compadre).toEqual({
      driver: ProviderDriverKind.make("compadre"),
      displayName: "Compadre",
      config: {},
    });
    expect(configMap[ProviderInstanceId.make("codex")]).toBeUndefined();
  });

  it("does not advertise Compadre in ordinary T3 installations", () => {
    const configMap = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS, {});

    expect(configMap[ProviderInstanceId.make("compadre")]).toBeUndefined();
  });

  it("preserves an explicit Compadre instance over environment bootstrap", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        ...DEFAULT_SERVER_SETTINGS.providerInstances,
        compadre: {
          driver: ProviderDriverKind.make("compadre"),
          displayName: "Explicit Compadre",
          enabled: false,
          config: {},
        },
      },
    };
    const configMap = deriveProviderInstanceConfigMap(settings, {
      COMPADRE_PROVIDER_URL: "https://compadre.example/hosted/chat",
    });

    expect(configMap[ProviderInstanceId.make("compadre")]?.displayName).toBe("Explicit Compadre");
    expect(configMap[ProviderInstanceId.make("compadre")]?.enabled).toBe(false);
  });
});
