import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { makeCompadreTextGeneration } from "../textGeneration/CompadreTextGeneration.ts";
import { makeCompadreAdapter } from "./Layers/CompadreAdapter.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "./providerMaintenance.ts";

export interface RemoteNativeProviderOptions {
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly agentProvider: "claude-code" | "codex";
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly enabled: boolean;
  readonly attachmentsDir: string;
  readonly snapshot: ServerProvider;
}

function remoteCodexCapabilities(
  efforts: ReadonlyArray<string>,
): ServerProviderModel["capabilities"] {
  return {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: efforts.map((id) => ({
          id,
          label: id === "xhigh" ? "Extra High" : `${id.slice(0, 1).toUpperCase()}${id.slice(1)}`,
          ...(id === "high" ? { isDefault: true as const } : {}),
        })),
        currentValue: "high",
      },
    ],
  };
}

const REMOTE_CODEX_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-5.6-sol",
    name: "GPT-5.6-Sol",
    isDefault: true,
    isCustom: false,
    capabilities: remoteCodexCapabilities(["low", "medium", "high", "xhigh", "max", "ultra"]),
  },
  {
    slug: "gpt-5.6-terra",
    name: "GPT-5.6-Terra",
    isCustom: false,
    capabilities: remoteCodexCapabilities(["low", "medium", "high", "xhigh", "max", "ultra"]),
  },
  {
    slug: "gpt-5.6-luna",
    name: "GPT-5.6-Luna",
    isCustom: false,
    capabilities: remoteCodexCapabilities(["low", "medium", "high", "xhigh", "max"]),
  },
];

/**
 * A hosted native driver cannot probe a local CLI for its catalog because the
 * CLI lives in the Modal worker. Use the catalog supported by this T3 build and
 * deliberately ignore stale `customModels` persisted by earlier experiments.
 */
export function remoteNativeProviderSnapshot(
  options: Pick<RemoteNativeProviderOptions, "agentProvider" | "enabled" | "snapshot">,
): ServerProvider {
  return {
    ...options.snapshot,
    enabled: options.enabled,
    installed: true,
    status: options.enabled ? "ready" : "disabled",
    auth: {
      status: "authenticated",
      type: "compadre-modal",
      label: "Isolated Modal worker",
    },
    availability: "available",
    message: "Provider execution runs in an isolated Modal T3 worker.",
    ...(options.agentProvider === "codex" ? { models: [...REMOTE_CODEX_MODELS] } : {}),
  };
}

/**
 * Hosted adapter for a native T3 provider. Central T3 keeps orchestration and
 * persistence local while Compadre routes provider work to an isolated Modal
 * T3 environment. The adapter still emits the provider's native driver kind,
 * so every client continues to see Codex or Claude rather than a proxy.
 */
export const makeRemoteNativeProvider = Effect.fn("makeRemoteNativeProvider")(function* (
  options: RemoteNativeProviderOptions,
) {
  const snapshotValue = remoteNativeProviderSnapshot(options);
  const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
    provider: options.driverKind,
    packageName: null,
  });
  const snapshot = {
    maintenanceCapabilities,
    getSnapshot: Effect.succeed(snapshotValue),
    refresh: Effect.succeed(snapshotValue),
    streamChanges: Stream.empty,
  };
  const adapter = yield* makeCompadreAdapter({
    endpoint: options.endpoint,
    instanceId: options.instanceId,
    provider: options.agentProvider,
    runtimeProvider: options.driverKind,
    attachmentsDir: options.attachmentsDir,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
  });
  const textGeneration = yield* makeCompadreTextGeneration({
    endpoint: options.endpoint,
    provider: options.agentProvider,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
  });
  return { snapshot, adapter, textGeneration };
});

export function remoteNativeProviderEndpoint(environment: NodeJS.ProcessEnv): string | undefined {
  return environment.COMPADRE_NATIVE_T3_URL?.trim() || undefined;
}
