import {
  launchManagedT3ModalEnvironment,
  restartManagedT3ModalEnvironment,
  restoreManagedT3ModalEnvironment,
  T3_GATEWAY_CREDENTIAL_PATH,
  T3_SLACK_DESTINATION_PATH,
  parseT3SlackDestinationMarker,
  type ManagedT3ModalEnvironment,
} from "./modal-worker.js";
import { log, serializeError } from "../logging.js";
import { modalSandboxProvider } from "../tanstack/modal-sandbox.js";
import { T3Client } from "./client.js";
import type { T3OrchestrationSnapshot } from "./client.js";
import type {
  T3EnvironmentConnection,
  T3EnvironmentConnectionManager,
} from "./gateway.js";
import { T3EnvironmentUnavailableError } from "./gateway.js";
import type { T3ThreadBinding } from "../services/t3-thread-bindings.js";
import { t3EncryptedPorts } from "./dev-environment.js";
import type { SandboxHandle } from "@tanstack/ai-sandbox";

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

export interface T3ModalEnvironmentDependencies {
  launch: typeof launchManagedT3ModalEnvironment;
  restore: typeof restoreManagedT3ModalEnvironment;
  restart: typeof restartManagedT3ModalEnvironment;
}

/** Reject provider launches that cannot authenticate before incurring sandbox cost. */
export function assertProviderCredentialsConfigured(
  providerInstanceId: string,
  environment: NodeJS.ProcessEnv,
): void {
  if (
    providerInstanceId === "claudeAgent" &&
    !environment.ANTHROPIC_API_KEY?.trim() &&
    !environment.CLAUDE_CODE_OAUTH_TOKEN?.trim()
  ) {
    throw new Error(
      "Claude Code is unavailable because neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is configured",
    );
  }
}

/**
 * Gives every external-conversation/provider pair its own Modal-hosted T3
 * environment. The reconnect credential lives inside that sandbox, so it is
 * not copied into Compadre's generic metadata rows.
 */
export class T3ModalEnvironmentManager implements T3EnvironmentConnectionManager {
  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly onProvisioned?: (
      environment: T3ModalProvisionedEnvironment,
    ) => void | Promise<void>,
    private readonly dependencies: Partial<T3ModalEnvironmentDependencies> = {},
  ) {}

  private workerEnvironment(
    binding?: T3ThreadBinding,
    generation = binding?.workerGeneration ?? 1,
  ): NodeJS.ProcessEnv {
    return {
      ...this.environment,
      COMPADRE_MODAL_APP:
        this.environment.COMPADRE_T3_MODAL_APP?.trim() || "compadre",
      ...(binding
        ? {
            COMPADRE_CANONICAL_THREAD_ID: binding.canonicalThreadId,
            COMPADRE_PROVIDER_INSTANCE_ID: binding.providerInstanceId,
            COMPADRE_WORKER_GENERATION: String(generation),
            ...(binding.blockedSlackDestination
              ? {
                  COMPADRE_BLOCKED_SLACK_CHANNEL_ID:
                    binding.blockedSlackDestination.channelId,
                  COMPADRE_BLOCKED_SLACK_THREAD_TS:
                    binding.blockedSlackDestination.threadTs,
                }
              : {}),
          }
        : {}),
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
    assertProviderCredentialsConfigured(input.providerInstanceId, this.environment);
    const launched = await (
      this.dependencies.launch ?? launchManagedT3ModalEnvironment
    )({
      ...this.environment,
      COMPADRE_CANONICAL_THREAD_ID: input.canonicalThreadId,
      COMPADRE_PROVIDER_INSTANCE_ID: input.providerInstanceId,
      COMPADRE_WORKER_GENERATION: "1",
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
    const workerEnvironment = this.workerEnvironment(binding);
    const provider = modalSandboxProvider({
      environment: workerEnvironment,
      encryptedPorts: t3EncryptedPorts(workerEnvironment),
    });
    const handle = await provider.resume({ id: binding.sandboxId });
    if (!handle) {
      throw new T3EnvironmentUnavailableError(binding.sandboxId, {
        canonicalThreadId: binding.canonicalThreadId,
        reason: "resume returned no handle (sandbox terminated?)",
      });
    }
    await this.assertProtectedSlackDestination(
      binding,
      handle,
      binding.sandboxId,
    );
    const accessToken = (
      await handle.fs.read(T3_GATEWAY_CREDENTIAL_PATH)
    ).trim();
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

  async restore(binding: T3ThreadBinding): Promise<T3EnvironmentConnection> {
    assertProviderCredentialsConfigured(binding.providerInstanceId, this.environment);
    if (!binding.workerSnapshotId) {
      throw new Error(
        `T3 thread ${binding.canonicalThreadId} has no worker snapshot to restore`,
      );
    }
    const launched = await (
      this.dependencies.restore ?? restoreManagedT3ModalEnvironment
    )(
      {
        snapshotId: binding.workerSnapshotId,
        projectId: binding.projectId,
        t3ThreadId: binding.t3ThreadId,
      },
      this.workerEnvironment(binding, (binding.workerGeneration ?? 1) + 1),
    );
    const connection = this.connection(launched);
    try {
      const snapshot = await launched.client.snapshot();
      assertIsolatedT3Environment(
        { ...binding, sandboxId: launched.sandboxId },
        snapshot,
      );
      await this.assertProtectedSlackDestination(
        binding,
        launched.handle,
        launched.sandboxId,
      );
      return connection;
    } catch (error) {
      await launched.handle.destroy().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Live filesystem checkpoint of a running worker. Nothing is quiesced or
   * terminated: the worker keeps serving follow-up turns, and the snapshot
   * exists so a later worker loss (sandbox lifetime, crash) restores from
   * this point instead of a fresh clone.
   */
  async checkpoint(
    binding: T3ThreadBinding,
    connection?: T3EnvironmentConnection,
  ): Promise<{ snapshotId: string }> {
    let sandbox = connection?.sandbox;
    if (!sandbox) {
      const workerEnvironment = this.workerEnvironment(binding);
      const provider = modalSandboxProvider({
        environment: workerEnvironment,
        encryptedPorts: t3EncryptedPorts(workerEnvironment),
      });
      const resumed = await provider.resume({ id: binding.sandboxId });
      if (!resumed) {
        throw new T3EnvironmentUnavailableError(binding.sandboxId, {
          canonicalThreadId: binding.canonicalThreadId,
          reason: "resume for checkpoint returned no handle",
        });
      }
      sandbox = resumed;
      await this.assertProtectedSlackDestination(
        binding,
        sandbox,
        binding.sandboxId,
      );
    }
    const capable = sandbox as typeof sandbox & {
      checkpoint?(label?: string): Promise<{ id: string }>;
    };
    if (!capable.checkpoint) {
      throw new Error("The native T3 worker does not support checkpoints");
    }
    const snapshot = await capable.checkpoint(
      `t3-worker-generation-${binding.workerGeneration ?? 1}`,
    );
    return { snapshotId: snapshot.id };
  }

  async discard(connection: T3EnvironmentConnection): Promise<void> {
    const provider = modalSandboxProvider({
      environment: this.workerEnvironment(),
      encryptedPorts: t3EncryptedPorts(this.workerEnvironment()),
    });
    await provider.destroy({ id: connection.sandboxId });
  }

  private async assertProtectedSlackDestination(
    binding: T3ThreadBinding,
    handle: SandboxHandle,
    sandboxId: string,
  ): Promise<void> {
    if (!binding.blockedSlackDestination) return;
    let marker: ReturnType<typeof parseT3SlackDestinationMarker>;
    try {
      marker = parseT3SlackDestinationMarker(
        await handle.fs.read(T3_SLACK_DESTINATION_PATH),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/not found|no such file|noent/i.test(message)) {
        // A busy sandbox can time out a filesystem read. That is a transient
        // I/O failure, not a missing security marker: misreporting it as a
        // destination violation blocked every reconnect to a healthy worker
        // for the rest of its life (2026-09-01). Surface it as the
        // reconnect failure it is so watchers ride it out.
        log.warn(
          {
            canonicalThreadId: binding.canonicalThreadId,
            sandboxId,
            markerPath: T3_SLACK_DESTINATION_PATH,
            outcome: "transient-read-failure",
            ...serializeError(error),
          },
          "protected slack destination marker read failed (transient)",
        );
        throw error;
      }
      marker = undefined;
    }
    if (
      marker?.channelId !== binding.blockedSlackDestination.channelId ||
      marker.threadTs !== binding.blockedSlackDestination.threadTs
    ) {
      log.error(
        {
          canonicalThreadId: binding.canonicalThreadId,
          sandboxId,
          outcome: marker ? "destination-mismatch" : "marker-missing",
          expectedChannelId: binding.blockedSlackDestination.channelId,
          expectedThreadTs: binding.blockedSlackDestination.threadTs,
          actualChannelId: marker?.channelId,
          actualThreadTs: marker?.threadTs,
        },
        "protected slack destination violation",
      );
      throw new Error(
        `T3 Modal sandbox ${sandboxId} does not have its protected Slack destination`,
      );
    }
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
