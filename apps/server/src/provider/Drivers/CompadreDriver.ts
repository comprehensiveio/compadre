import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";

import { ServerConfig } from "../../config.ts";
import { makeCompadreTextGeneration } from "../../textGeneration/CompadreTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCompadreAdapter } from "../Layers/CompadreAdapter.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

const DRIVER_KIND = ProviderDriverKind.make("compadre");
const CompadreSettings = Schema.Struct({});
type CompadreSettings = typeof CompadreSettings.Type;

type CompadreAgentProvider = "claude-code" | "codex";

export type CompadreDriverEnv =
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ServerConfig;

function configuredAgent(value: string | undefined): CompadreAgentProvider | undefined {
  return value === "claude-code" || value === "codex" ? value : undefined;
}

export const CompadreDriver: ProviderDriver<CompadreSettings, CompadreDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Compadre", supportsMultipleInstances: false },
  configSchema: CompadreSettings,
  defaultConfig: () => ({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled }) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const endpoint = processEnv.COMPADRE_PROVIDER_URL?.trim();
      if (!endpoint) {
        return yield* new ProviderDriverError({
          driver: DRIVER_KIND,
          instanceId,
          detail: "COMPADRE_PROVIDER_URL is required for the Compadre provider.",
        });
      }

      const apiKey = processEnv.COMPADRE_API_KEY?.trim() || undefined;
      const provider = configuredAgent(processEnv.COMPADRE_PROVIDER_AGENT);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: null,
      });
      const snapshotValue: ServerProvider = {
        instanceId,
        driver: DRIVER_KIND,
        displayName: displayName ?? "Compadre",
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
        enabled,
        installed: true,
        version: null,
        status: enabled ? "ready" : "disabled",
        auth: {
          status: "authenticated",
          type: "compadre",
          label: apiKey ? "Compadre API key" : "Internal Compadre service",
        },
        checkedAt: DateTime.formatIso(yield* DateTime.now),
        availability: "available",
        models: [
          {
            slug: "claude-code",
            name: "Claude Code",
            isCustom: false,
            isDefault: provider !== "codex",
            capabilities: null,
          },
          {
            slug: "codex",
            name: "Codex",
            isCustom: false,
            isDefault: provider === "codex",
            capabilities: null,
          },
        ],
        slashCommands: [],
        skills: [],
      };
      const snapshot = {
        maintenanceCapabilities,
        getSnapshot: Effect.succeed(snapshotValue),
        refresh: Effect.succeed(snapshotValue),
        streamChanges: Stream.empty,
      };
      const adapter = yield* makeCompadreAdapter({
        endpoint,
        instanceId,
        attachmentsDir: serverConfig.attachmentsDir,
        ...(apiKey ? { apiKey } : {}),
        ...(provider ? { provider } : {}),
      });
      const textGeneration = yield* makeCompadreTextGeneration({
        endpoint,
        ...(apiKey ? { apiKey } : {}),
        ...(provider ? { provider } : {}),
      });

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      };
    }),
};
