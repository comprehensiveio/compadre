import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { ProviderDriverError } from "./Errors.ts";
import * as CodexSchema from "effect-codex-app-server/schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as ModelManifest from "./ModelManifest.ts";
import { resolveClaudeModelCatalog, resolveClaudeModelsForVersion } from "./ClaudeModelCatalog.ts";
import { parseCodexModelListResponse } from "./Layers/CodexProvider.ts";
import { makeManagedServerProvider } from "./makeManagedServerProvider.ts";

import { makeCompadreTextGeneration } from "../textGeneration/CompadreTextGeneration.ts";
import { makeCompadreAdapter } from "./Layers/CompadreAdapter.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "./providerMaintenance.ts";

const decodeProviderVersion = Schema.decodeUnknownEffect(
  Schema.Struct({
    version: Schema.String,
    providerActions: Schema.optional(Schema.Array(Schema.String)),
  }),
);
const decodeCodexModels = Schema.decodeUnknownEffect(CodexSchema.V2ModelListResponse);

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

/** Hosted snapshots receive the discovered catalog; no model allowlist lives here. */
export function remoteNativeProviderSnapshot(
  options: Pick<RemoteNativeProviderOptions, "agentProvider" | "enabled" | "snapshot">,
): ServerProvider {
  return {
    ...options.snapshot,
    providerActions: [],
    enabled: options.enabled,
    installed: true,
    status: options.enabled ? "ready" : "disabled",
    auth: { status: "authenticated", type: "compadre-modal", label: "Isolated Modal worker" },
    availability: "available",
    message: "Provider execution runs in an isolated Modal T3 worker.",
  };
}

/** Shares refresh and outage behavior between the hosted drivers and focused transport tests. */
export function makeRemoteProviderModelCheck(
  options: RemoteNativeProviderOptions,
  httpClient: HttpClient.HttpClient,
  manifest: ModelManifest.ModelManifest["Service"],
) {
  let snapshotValue = {
    ...remoteNativeProviderSnapshot(options),
    models: [],
    status: options.enabled ? "warning" : "disabled",
    message: "Discovering worker provider models.",
  } as ServerProvider;
  const checkProvider = Effect.gen(function* () {
    if (!options.enabled) return snapshotValue;
    const url = new URL(`/hosted/t3/providers/${options.agentProvider}/models`, options.endpoint);
    const request = HttpClientRequest.get(url, {
      headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {},
    });
    const response = yield* httpClient.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout("25 seconds"),
    );
    const { version, providerActions } = yield* decodeProviderVersion(response);
    const catalog = yield* manifest.refresh;
    const models =
      options.agentProvider === "codex"
        ? ModelManifest.classifyModels(
            parseCodexModelListResponse(yield* decodeCodexModels(response)),
            catalog,
            options.driverKind,
          )
        : resolveClaudeModelsForVersion(resolveClaudeModelCatalog(catalog), version);
    snapshotValue = {
      ...remoteNativeProviderSnapshot(options),
      models,
      version,
      providerActions:
        options.agentProvider === "claude-code"
          ? (providerActions ?? []).filter((action) => action === "compact")
          : [],
      checkedAt: DateTime.formatIso(yield* DateTime.now),
    };
    return snapshotValue;
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed({
        ...snapshotValue,
        status: "warning" as const,
        message: snapshotValue.models.length
          ? "Model discovery is temporarily unavailable; showing the last successful catalog."
          : "Worker model discovery is unavailable. Refresh providers after the controller is updated.",
      }),
    ),
  );

  return { initialSnapshot: snapshotValue, checkProvider };
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
  const httpClient = yield* HttpClient.HttpClient;
  const manifest = yield* ModelManifest.make;
  const { initialSnapshot, checkProvider } = makeRemoteProviderModelCheck(
    options,
    httpClient,
    manifest,
  );
  const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
    provider: options.driverKind,
    packageName: null,
  });
  const snapshot = yield* makeManagedServerProvider({
    resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
    getSettings: Effect.succeed(options.enabled),
    streamSettings: Stream.empty,
    haveSettingsChanged: (previous, next) => previous !== next,
    initialSnapshot: () => Effect.succeed(initialSnapshot),
    checkProvider,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderDriverError({
          driver: options.driverKind,
          instanceId: options.instanceId,
          detail: "Failed to initialize remote model discovery.",
          cause,
        }),
    ),
  );
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
