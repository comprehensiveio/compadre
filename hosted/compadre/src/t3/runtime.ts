import { NativeThreadDelivery, nativeDeliverySink } from "./native-events.js";
import { T3VerificationStore } from "./verification.js";
import { prepareNativeDelivery } from "./native-delivery.js";
import { ensureNativeThreadDeliveryWorkflow } from "../temporal/client.js";
import { WorkspaceReviewStore } from "./workspace-review.js";
import crypto from "node:crypto";
import { log } from "../logging.js";
import { getConfiguredAgentRunDurability } from "../durability/runtime.js";
import { getConfiguredThreadPersistence } from "../persistence/runtime.js";
import { recoverCentralT3DurableRuns } from "../services/central-t3-run.js";
import { T3ThreadBindingStore } from "../services/t3-thread-bindings.js";
import { T3Gateway } from "./gateway.js";
import { CodexSubscriptionLane } from "./codex-subscription-lane.js";
import { configuredCentralT3Client } from "./central-conversation.js";
import { T3ModalEnvironmentManager } from "./modal-environments.js";
import { codexApiAuthJsonFromEnvironment } from "./modal-worker.js";
import { readWorkerTemplate } from "./worker-templates.js";
import type { NativeT3RunDriverDependencies } from "./native-t3-run-driver.js";
import { NativeT3RunCoordinator } from "./run-coordinator.js";
import { NativeT3RunRequestStore } from "./run-request-store.js";
import { NativeT3RunControlStore } from "./run-control.js";
import {
  createTemporalNativeT3WorkflowLauncher,
  TemporalNativeT3RunService,
  type NativeT3RunService,
} from "./run-service.js";
import { S3T3ArtifactObjectStore, T3ArtifactStore } from "./artifact-store.js";
import {
  PreviewActivationService,
  PreviewActivationStore,
} from "../services/preview-activation.js";

let configuredGateway: Promise<T3Gateway | null> | undefined;
let configuredRunCoordinator:
  | Promise<NativeT3RunCoordinator | null>
  | undefined;
let configuredArtifactStore: Promise<T3ArtifactStore | null> | undefined;
let configuredRunService: Promise<NativeT3RunService | null> | undefined;
let configuredPreviewActivationService:
  | Promise<PreviewActivationService | null>
  | undefined;

const DEFAULT_MODAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export function nativeT3GatewayEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return [
    "COMPADRE_T3_DIRECTORY_ENABLED",
    "COMPADRE_T3_SLACK_ENABLED",
    "COMPADRE_T3_API_ENABLED",
    "COMPADRE_HOSTED_T3_ENABLED",
  ].some((name) => environment[name] === "true");
}

function positiveDurationSetting(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

export async function getConfiguredT3ArtifactStore(): Promise<T3ArtifactStore | null> {
  if (!configuredArtifactStore) {
    const initialization = getConfiguredThreadPersistence()
      .then(async (runtime) => {
        const bucket = process.env.COMPADRE_T3_ARTIFACT_BUCKET?.trim();
        const region =
          process.env.COMPADRE_T3_ARTIFACT_REGION?.trim() ||
          process.env.AWS_REGION?.trim() ||
          process.env.AWS_DEFAULT_REGION?.trim();
        if (!runtime || !bucket || !region) return null;
        const store = new T3ArtifactStore(
          new S3T3ArtifactObjectStore(bucket, { region }),
          runtime.persistence.stores.metadata,
        );
        await store.check();
        return store;
      })
      .catch((error) => {
        if (configuredArtifactStore === initialization)
          configuredArtifactStore = undefined;
        throw error;
      });
    configuredArtifactStore = initialization;
  }
  return configuredArtifactStore;
}

export async function getConfiguredWorkspaceReviewStore() {
  const [artifacts, persistence] = await Promise.all([getConfiguredT3ArtifactStore(), getConfiguredThreadPersistence()]);
  return artifacts && persistence ? new WorkspaceReviewStore(artifacts, persistence.persistence.stores.metadata) : null;
}

/** Shared native-T3 coordinator used by HTTP, Slack, and simulations. */
export async function getConfiguredT3Gateway(): Promise<T3Gateway | null> {
  if (!configuredGateway) {
    const initialization = getConfiguredThreadPersistence()
      .then((runtime) => {
        if (!runtime) return null;
        const bindings = new T3ThreadBindingStore(
          runtime.persistence.stores.metadata,
          runtime.locks,
        );
        const codexSubscriptionLane = new CodexSubscriptionLane(
          runtime.persistence.stores.metadata,
          runtime.locks,
          process.env,
        );
        log.info(
          {
            codexAuthMode: codexSubscriptionLane.enabled
              ? "subscription_canary"
              : codexSubscriptionLane.managed
                ? "managed_api_only"
                : "legacy_unmanaged",
            codexSubscriptionExperimentEnabled: codexSubscriptionLane.enabled,
            codexSubscriptionExperimentManaged: codexSubscriptionLane.managed,
          },
          "Codex auth routing initialized",
        );
        const gateway = new T3Gateway(
          bindings,
          new T3ModalEnvironmentManager(process.env, undefined, {
            workerTemplate: () =>
              readWorkerTemplate(runtime.persistence.stores.metadata),
          }),
          crypto.randomUUID,
          () => new Date(),
          runtime.locks,
          undefined,
          configuredCentralT3Client() ?? undefined,
          {
            maxLiveMs: positiveDurationSetting(
              "COMPADRE_MODAL_TIMEOUT_MS",
              process.env.COMPADRE_MODAL_TIMEOUT_MS,
              DEFAULT_MODAL_TIMEOUT_MS,
            ),
          },
          codexSubscriptionLane,
          codexApiAuthJsonFromEnvironment(process.env),
        );
        return gateway;
      })
      .catch((error) => {
        if (configuredGateway === initialization) configuredGateway = undefined;
        throw error;
      });
    configuredGateway = initialization;
  }
  return configuredGateway;
}

export async function getConfiguredPreviewActivationService(): Promise<PreviewActivationService | null> {
  if (!configuredPreviewActivationService) {
    const initialization = getConfiguredThreadPersistence()
      .then((runtime) =>
        runtime
          ? new PreviewActivationService(
              new PreviewActivationStore(
                runtime.persistence.stores.metadata,
                () => new Date(),
                runtime.locks,
              ),
              runtime.locks,
            )
          : null,
      )
      .catch((error) => {
        if (configuredPreviewActivationService === initialization) {
          configuredPreviewActivationService = undefined;
        }
        throw error;
      });
    configuredPreviewActivationService = initialization;
  }
  return configuredPreviewActivationService;
}

/** Reclaim provider streams left behind by a previous controller process. */
export async function recoverConfiguredNativeT3Runs(): Promise<
  { scanned: number; resumed: number; skipped: number;
    compatibilityScanned: number;
    compatibilityResumed: number;
    compatibilitySkipped: number;
  }
> {
  const [gateway, coordinator] = await Promise.all([
    getConfiguredT3Gateway(),
    getConfiguredNativeT3RunCoordinator(),
  ]);
  if (!gateway || !coordinator) {
    return {
      scanned: 0,
      resumed: 0,
      skipped: 0,
      compatibilityScanned: 0,
      compatibilityResumed: 0,
      compatibilitySkipped: 0,
    };
  }
  // Under Temporal orchestration the workflow's drive activity is the only
  // native-run producer: its retries already reattach after a controller
  // restart, and a second in-process producer would only trade epoch claims
  // with the activity. Compatibility-run recovery stays in-process.
  const client = configuredCentralT3Client();
  const compatibility = client
    ? await recoverCentralT3DurableRuns({ coordinator, client })
    : { scanned: 0, resumed: 0, skipped: 0 };
  return {
    scanned: 0, resumed: 0, skipped: 0,
    compatibilityScanned: compatibility.scanned,
    compatibilityResumed: compatibility.resumed,
    compatibilitySkipped: compatibility.skipped,
  };
}

export async function buildRunRequestStore(): Promise<NativeT3RunRequestStore | null> {
  const runtime = await getConfiguredThreadPersistence();
  if (!runtime) return null;
  const bucket = process.env.COMPADRE_T3_ARTIFACT_BUCKET?.trim();
  const region = process.env.COMPADRE_T3_ARTIFACT_REGION?.trim() || process.env.AWS_REGION?.trim() || process.env.AWS_DEFAULT_REGION?.trim();
  return new NativeT3RunRequestStore(runtime.persistence.stores.metadata,
    bucket && region ? new S3T3ArtifactObjectStore(bucket, { region }) : undefined,
    async (threadId) => {
      if (await new T3VerificationStore(runtime.persistence.stores.metadata, runtime.locks).consume(threadId, "request")) {
        throw new Error("Verification: request persistence failed");
      }
    });
}

async function buildRunControlStore(): Promise<NativeT3RunControlStore | null> {
  const runtime = await getConfiguredThreadPersistence();
  if (!runtime) return null;
  return new NativeT3RunControlStore(
    runtime.persistence.stores.metadata,
    runtime.locks,
  );
}

let overriddenDriverDependencies: NativeT3RunDriverDependencies | undefined;

/** Probe/test seam: substitute the gateway and stores the activities use. */
export function setNativeT3RunDriverDependenciesForTests(dependencies: NativeT3RunDriverDependencies | undefined): void {
  overriddenDriverDependencies = dependencies;
}

export async function getConfiguredNativeThreadDelivery(): Promise<NativeThreadDelivery | null> {
  const persistence = await getConfiguredThreadPersistence();
  const central = configuredCentralT3Client();
  const apiKey = process.env.COMPADRE_API_KEY?.trim();
  if (!persistence || !central || !apiKey) return null;
  return new NativeThreadDelivery(persistence.persistence.stores.metadata, persistence.locks,
    nativeDeliverySink({ baseUrl: central.baseUrl, apiKey,
      verificationFault: (threadId) => new T3VerificationStore(persistence.persistence.stores.metadata, persistence.locks).consume(threadId, "delivery"),
    }));
}

/** Dependencies for the durable drive/finalize activities. */
export async function getConfiguredNativeT3RunDriverDependencies(): Promise<NativeT3RunDriverDependencies | null> {
  if (overriddenDriverDependencies) return overriddenDriverDependencies;
  const [gateway, durability, requests, controls, persistence] = await Promise.all([
    getConfiguredT3Gateway(),
    getConfiguredAgentRunDurability(),
    buildRunRequestStore(),
    buildRunControlStore(),
    getConfiguredThreadPersistence(),
  ]);
  if (!gateway || !durability || !requests || !controls || !persistence) return null;
  return {
    gateway,
    durability,
    requests,
    controls,
    locks: persistence.locks,
    prepareNativeDelivery: async (request, connection) => {
      const delivery = await getConfiguredNativeThreadDelivery();
      const central = configuredCentralT3Client();
      if (!delivery || !central) throw new Error("Native event delivery is not configured");
      const attached = connection ?? await gateway.attachWorker(request.canonicalThreadId);
      if (!attached) throw new Error("Native event worker is unavailable");
      await prepareNativeDelivery({ delivery, central, request, connection: attached, start: ensureNativeThreadDeliveryWorkflow });
    },
  };
}

/** Durable lifecycle producer for /hosted/t3/chat. */
export async function getConfiguredNativeT3RunService(): Promise<NativeT3RunService | null> {
  if (!configuredRunService) {
    const initialization = (async () => {
      const [gateway, coordinator, requests, persistence] = await Promise.all([
        getConfiguredT3Gateway(),
        getConfiguredNativeT3RunCoordinator(),
        buildRunRequestStore(),
        getConfiguredThreadPersistence(),
      ]);
      if (!gateway || !coordinator || !requests || !persistence) return null;
      return new TemporalNativeT3RunService(coordinator, requests, createTemporalNativeT3WorkflowLauncher(), Date.now, persistence.locks);
    })().catch((error) => {
      if (configuredRunService === initialization) {
        configuredRunService = undefined;
      }
      throw error;
    });
    configuredRunService = initialization;
  }
  return configuredRunService;
}

/** Shared durable producer used by the native provider POST and replay routes. */
export async function getConfiguredNativeT3RunCoordinator(): Promise<NativeT3RunCoordinator | null> {
  if (!configuredRunCoordinator) {
    const initialization = Promise.all([
      getConfiguredThreadPersistence(),
      getConfiguredAgentRunDurability(),
    ])
      .then(([persistence, durability]) => {
        if (!persistence || !durability) return null;
        return new NativeT3RunCoordinator(durability, persistence.locks);
      })
      .catch((error) => {
        if (configuredRunCoordinator === initialization) {
          configuredRunCoordinator = undefined;
        }
        throw error;
      });
    configuredRunCoordinator = initialization;
  }
  return configuredRunCoordinator;
}
