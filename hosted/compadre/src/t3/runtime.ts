import crypto from "node:crypto";
import { getConfiguredAgentRunDurability } from "../durability/runtime.js";
import { getConfiguredThreadPersistence } from "../persistence/runtime.js";
import { recoverCentralT3DurableRuns } from "../services/central-t3-run.js";
import { T3ThreadBindingStore } from "../services/t3-thread-bindings.js";
import { T3ThreadSnapshotStore } from "../services/t3-thread-snapshots.js";
import { NATIVE_T3_RUN_ORCHESTRATOR } from "../temporal/mode.js";
import { collectNativeT3ArtifactEvents } from "./artifact-events.js";
import { T3Gateway } from "./gateway.js";
import { CodexSubscriptionLane } from "./codex-subscription-lane.js";
import { configuredCentralT3Client } from "./central-conversation.js";
import { T3ModalEnvironmentManager } from "./modal-environments.js";
import { readWorkerTemplate } from "./worker-templates.js";
import type { NativeT3RunDriverDependencies } from "./native-t3-run-driver.js";
import { NativeT3RunCoordinator } from "./run-coordinator.js";
import { recoverNativeT3Runs, type NativeT3RecoverySummary } from "./run-recovery.js";
import { NativeT3RunRequestStore } from "./run-request-store.js";
import {
  createTemporalNativeT3WorkflowLauncher,
  InProcessNativeT3RunService,
  TemporalNativeT3RunService,
  type NativeT3RunService,
} from "./run-service.js";
import {
  S3T3ArtifactObjectStore,
  T3ArtifactStore,
} from "./artifact-store.js";

let configuredGateway: Promise<T3Gateway | null> | undefined;
let configuredRunCoordinator: Promise<NativeT3RunCoordinator | null> | undefined;
let configuredArtifactStore: Promise<T3ArtifactStore | null> | undefined;
let configuredRunService: Promise<NativeT3RunService | null> | undefined;

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
    const initialization = getConfiguredThreadPersistence().then(async (runtime) => {
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
    }).catch((error) => {
      if (configuredArtifactStore === initialization) configuredArtifactStore = undefined;
      throw error;
    });
    configuredArtifactStore = initialization;
  }
  return configuredArtifactStore;
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
        const snapshots = new T3ThreadSnapshotStore(
          runtime.persistence.stores.metadata,
          runtime.locks,
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
          snapshots,
          {
            maxLiveMs: positiveDurationSetting(
              "COMPADRE_MODAL_TIMEOUT_MS",
              process.env.COMPADRE_MODAL_TIMEOUT_MS,
              DEFAULT_MODAL_TIMEOUT_MS,
            ),
          },
          new CodexSubscriptionLane(
            runtime.persistence.stores.metadata,
            runtime.locks,
            process.env,
          ),
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

/** Reclaim provider streams left behind by a previous controller process. */
export async function recoverConfiguredNativeT3Runs(): Promise<
  NativeT3RecoverySummary & {
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
  const provider =
    NATIVE_T3_RUN_ORCHESTRATOR === "temporal"
      ? { scanned: 0, resumed: 0, skipped: 0 }
      : await recoverNativeT3Runs({ gateway, coordinator });
  const client = configuredCentralT3Client();
  const compatibility = client
    ? await recoverCentralT3DurableRuns({ coordinator, client })
    : { scanned: 0, resumed: 0, skipped: 0 };
  return {
    ...provider,
    compatibilityScanned: compatibility.scanned,
    compatibilityResumed: compatibility.resumed,
    compatibilitySkipped: compatibility.skipped,
  };
}

async function buildRunRequestStore(): Promise<NativeT3RunRequestStore | null> {
  const runtime = await getConfiguredThreadPersistence();
  if (!runtime) return null;
  return new NativeT3RunRequestStore(runtime.persistence.stores.metadata);
}

async function buildCollectArtifactEvents(
  gateway: T3Gateway,
): Promise<NativeT3RunDriverDependencies["collectArtifactEvents"]> {
  const artifactStore = await getConfiguredT3ArtifactStore().catch((error) => {
    console.warn("[t3-artifacts] artifact store unavailable", { error });
    return null;
  });
  if (!artifactStore) return undefined;
  return (turn, request) =>
    collectNativeT3ArtifactEvents({
      gateway,
      artifactStore,
      turn,
      runId: request.runId,
      ...(request.slackArtifactDestination
        ? { slackDestination: request.slackArtifactDestination }
        : {}),
      ...(process.env.SLACK_BOT_TOKEN?.trim()
        ? { botToken: process.env.SLACK_BOT_TOKEN.trim() }
        : {}),
    });
}

let overriddenDriverDependencies: NativeT3RunDriverDependencies | undefined;

/** Probe/test seam: substitute the gateway and stores the activities use. */
export function setNativeT3RunDriverDependenciesForTests(
  dependencies: NativeT3RunDriverDependencies | undefined,
): void {
  overriddenDriverDependencies = dependencies;
}

/** Dependencies for the durable drive/finalize activities. */
export async function getConfiguredNativeT3RunDriverDependencies(): Promise<NativeT3RunDriverDependencies | null> {
  if (overriddenDriverDependencies) return overriddenDriverDependencies;
  const [gateway, durability, requests, persistence] = await Promise.all([
    getConfiguredT3Gateway(),
    getConfiguredAgentRunDurability(),
    buildRunRequestStore(),
    getConfiguredThreadPersistence(),
  ]);
  if (!gateway || !durability || !requests || !persistence) return null;
  const collectArtifactEvents = await buildCollectArtifactEvents(gateway);
  return {
    gateway,
    durability,
    requests,
    locks: persistence.locks,
    ...(collectArtifactEvents ? { collectArtifactEvents } : {}),
  };
}

/** Producer for /hosted/t3/chat, selected by NATIVE_T3_RUN_ORCHESTRATOR. */
export async function getConfiguredNativeT3RunService(): Promise<NativeT3RunService | null> {
  if (!configuredRunService) {
    const initialization = (async () => {
      const [gateway, coordinator, requests] = await Promise.all([
        getConfiguredT3Gateway(),
        getConfiguredNativeT3RunCoordinator(),
        buildRunRequestStore(),
      ]);
      if (!gateway || !coordinator || !requests) return null;
      if (NATIVE_T3_RUN_ORCHESTRATOR === "temporal") {
        return new TemporalNativeT3RunService(
          coordinator,
          requests,
          createTemporalNativeT3WorkflowLauncher(),
        );
      }
      const collectArtifactEvents = await buildCollectArtifactEvents(gateway);
      return new InProcessNativeT3RunService({
        gateway,
        coordinator,
        ...(collectArtifactEvents ? { collectArtifactEvents } : {}),
      });
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
