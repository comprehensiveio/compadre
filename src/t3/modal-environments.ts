import {
  launchManagedT3ModalEnvironment,
  T3_GATEWAY_CREDENTIAL_PATH,
  type ManagedT3ModalEnvironment,
} from "./modal-worker.js";
import { modalSandboxProvider } from "../tanstack/modal-sandbox.js";
import { T3Client } from "./client.js";
import type { T3OrchestrationSnapshot } from "./client.js";
import type {
  T3EnvironmentConnection,
  T3EnvironmentConnectionManager,
} from "./gateway.js";
import type { T3ThreadBinding } from "../services/t3-thread-bindings.js";
import { t3EncryptedPorts } from "./dev-environment.js";

const T3_PORT = 3773;

export function assertIsolatedT3Environment(
  binding: T3ThreadBinding,
  snapshot: T3OrchestrationSnapshot,
): void {
  if (!snapshot.projects.some((project) => project.id === binding.projectId)) {
    throw new Error(
      `T3 Modal sandbox ${binding.sandboxId} no longer contains its assigned project`,
    );
  }
  if (!snapshot.threads.some((thread) => thread.id === binding.t3ThreadId)) {
    throw new Error(
      `T3 Modal sandbox ${binding.sandboxId} no longer contains its assigned thread`,
    );
  }
  if (snapshot.threads.some((thread) => thread.id !== binding.t3ThreadId)) {
    throw new Error(
      `T3 Modal sandbox ${binding.sandboxId} violates one-thread isolation`,
    );
  }
}

export interface T3ModalProvisionedEnvironment {
  canonicalThreadId: string;
  providerInstanceId: string;
  sandboxId: string;
  pairingUrl: string;
}

/**
 * Gives every external-conversation/provider pair its own Modal-hosted T3
 * environment. The reconnect credential lives inside that sandbox, so it is
 * not copied into Compadre's generic metadata rows.
 */
export class T3ModalEnvironmentManager
  implements T3EnvironmentConnectionManager
{
  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly onProvisioned?: (
      environment: T3ModalProvisionedEnvironment,
    ) => void | Promise<void>,
  ) {}

  private workerEnvironment(): NodeJS.ProcessEnv {
    return {
      ...this.environment,
      COMPADRE_MODAL_APP:
        this.environment.COMPADRE_T3_MODAL_APP?.trim() ||
        "compadre",
    };
  }

  async provision(input: {
    canonicalThreadId: string;
    providerInstanceId: string;
    blockedSlackDestination?: {
      channelId: string;
      threadTs: string;
    };
  }): Promise<T3EnvironmentConnection> {
    const launched = await launchManagedT3ModalEnvironment({
      ...this.environment,
      COMPADRE_CANONICAL_THREAD_ID: input.canonicalThreadId,
      COMPADRE_PROVIDER_INSTANCE_ID: input.providerInstanceId,
      ...(input.blockedSlackDestination
        ? {
            COMPADRE_BLOCKED_SLACK_CHANNEL_ID:
              input.blockedSlackDestination.channelId,
            COMPADRE_BLOCKED_SLACK_THREAD_TS:
              input.blockedSlackDestination.threadTs,
          }
        : {}),
    });
    await this.onProvisioned?.({
      ...input,
      sandboxId: launched.sandboxId,
      pairingUrl: launched.pairingUrl,
    });
    return this.connection(launched);
  }

  async reconnect(binding: T3ThreadBinding): Promise<T3EnvironmentConnection> {
    const provider = modalSandboxProvider({
      environment: this.workerEnvironment(),
      encryptedPorts: t3EncryptedPorts(this.workerEnvironment()),
    });
    const handle = await provider.resume({ id: binding.sandboxId });
    if (!handle) {
      throw new Error(`T3 Modal sandbox ${binding.sandboxId} is unavailable`);
    }
    const accessToken = (await handle.fs.read(T3_GATEWAY_CREDENTIAL_PATH)).trim();
    if (!accessToken) {
      throw new Error(
        `T3 Modal sandbox ${binding.sandboxId} has no gateway credential`,
      );
    }
    const channel = await handle.ports.connect(T3_PORT);
    const client = new T3Client(channel.url, accessToken);
    const snapshot = await client.snapshot();
    assertIsolatedT3Environment(binding, snapshot);
    return {
      sandboxId: binding.sandboxId,
      projectId: binding.projectId,
      client,
      sandbox: handle,
    };
  }

  async discard(connection: T3EnvironmentConnection): Promise<void> {
    const provider = modalSandboxProvider({
      environment: this.workerEnvironment(),
      encryptedPorts: t3EncryptedPorts(this.workerEnvironment()),
    });
    await provider.destroy({ id: connection.sandboxId });
  }

  private connection(
    launched: ManagedT3ModalEnvironment,
  ): T3EnvironmentConnection {
    return {
      sandboxId: launched.sandboxId,
      projectId: launched.projectId,
      client: launched.client,
      sandbox: launched.handle,
    };
  }
}
