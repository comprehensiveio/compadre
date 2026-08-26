import crypto from "node:crypto";
import { getConfiguredThreadPersistence } from "../persistence/runtime.js";
import { T3ThreadBindingStore } from "../services/t3-thread-bindings.js";
import { T3ThreadSnapshotStore } from "../services/t3-thread-snapshots.js";
import { T3Gateway } from "./gateway.js";
import { T3ModalEnvironmentManager } from "./modal-environments.js";

let configuredGateway: Promise<T3Gateway | null> | undefined;

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
