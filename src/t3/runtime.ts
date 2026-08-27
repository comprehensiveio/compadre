import crypto from "node:crypto";
import { getConfiguredAgentRunDurability } from "../durability/runtime.js";
import { getConfiguredThreadPersistence } from "../persistence/runtime.js";
import { T3ThreadBindingStore } from "../services/t3-thread-bindings.js";
import { T3ThreadSnapshotStore } from "../services/t3-thread-snapshots.js";
import { T3Gateway } from "./gateway.js";
import { T3ModalEnvironmentManager } from "./modal-environments.js";
import { NativeT3RunCoordinator } from "./run-coordinator.js";

let configuredGateway: Promise<T3Gateway | null> | undefined;
let configuredRunCoordinator: Promise<NativeT3RunCoordinator | null> | undefined;

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
        return new T3Gateway(
          bindings,
          new T3ModalEnvironmentManager(),
          crypto.randomUUID,
          () => new Date(),
          runtime.locks,
          undefined,
          snapshots,
        );
      })
      .catch((error) => {
        if (configuredGateway === initialization) configuredGateway = undefined;
        throw error;
      });
    configuredGateway = initialization;
  }
  return configuredGateway;
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
