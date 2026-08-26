import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
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

/**
 * Hosted adapter for a native T3 provider. Central T3 keeps orchestration and
 * persistence local while Compadre routes provider work to an isolated Modal
 * T3 environment. The adapter still emits the provider's native driver kind,
 * so every client continues to see Codex or Claude rather than a proxy.
 */
export const makeRemoteNativeProvider = Effect.fn("makeRemoteNativeProvider")(function* (
  options: RemoteNativeProviderOptions,
) {
  const snapshotValue: ServerProvider = {
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
  };
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
