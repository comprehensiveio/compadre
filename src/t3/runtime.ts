import crypto from "node:crypto";
import { getConfiguredAgentRunDurability } from "../durability/runtime.js";
import { getConfiguredThreadPersistence } from "../persistence/runtime.js";
import { T3ThreadBindingStore } from "../services/t3-thread-bindings.js";
import { T3ThreadSnapshotStore } from "../services/t3-thread-snapshots.js";
import { T3Gateway } from "./gateway.js";
import { T3ModalEnvironmentManager } from "./modal-environments.js";
import { NativeT3RunCoordinator } from "./run-coordinator.js";
import {
  S3T3ArtifactObjectStore,
  T3ArtifactStore,
} from "./artifact-store.js";

let configuredGateway: Promise<T3Gateway | null> | undefined;
let stopConfiguredGatewaySweeper: (() => void) | undefined;
let configuredRunCoordinator: Promise<NativeT3RunCoordinator | null> | undefined;
let configuredArtifactStore: Promise<T3ArtifactStore | null> | undefined;

const DEFAULT_T3_WORKER_WARM_TTL_MS = 30 * 60 * 1000;
const DEFAULT_T3_WORKER_SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_MODAL_TIMEOUT_MS = 2 * 60 * 60 * 1000;

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
          new T3ModalEnvironmentManager(),
          crypto.randomUUID,
          () => new Date(),
          runtime.locks,
          undefined,
          snapshots,
          {
            warmLeaseMs: positiveDurationSetting(
              "COMPADRE_T3_WORKER_WARM_TTL_MS",
              process.env.COMPADRE_T3_WORKER_WARM_TTL_MS,
              DEFAULT_T3_WORKER_WARM_TTL_MS,
            ),
            maxLiveMs: positiveDurationSetting(
              "COMPADRE_MODAL_TIMEOUT_MS",
              process.env.COMPADRE_MODAL_TIMEOUT_MS,
              DEFAULT_MODAL_TIMEOUT_MS,
            ),
          },
        );
        stopConfiguredGatewaySweeper = gateway.startWorkerLifecycleSweeper(
          positiveDurationSetting(
            "COMPADRE_T3_WORKER_SWEEP_INTERVAL_MS",
            process.env.COMPADRE_T3_WORKER_SWEEP_INTERVAL_MS,
            DEFAULT_T3_WORKER_SWEEP_INTERVAL_MS,
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

/** Stop periodic worker lifecycle work before the controller begins draining. */
export function stopConfiguredT3WorkerLifecycle(): void {
  stopConfiguredGatewaySweeper?.();
  stopConfiguredGatewaySweeper = undefined;
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
