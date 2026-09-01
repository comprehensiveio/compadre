import {
  launchManagedT3ModalEnvironment,
  restartManagedT3ModalEnvironment,
  restoreManagedT3ModalEnvironment,
  T3_GATEWAY_CREDENTIAL_PATH,
  T3_SLACK_DESTINATION_PATH,
  parseT3SlackDestinationMarker,
  type ManagedT3ModalEnvironment,
} from "./modal-worker.js";
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
      throw new T3EnvironmentUnavailableError(binding.sandboxId);
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

  async hibernate(
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
        throw new T3EnvironmentUnavailableError(binding.sandboxId);
      }
      sandbox = resumed;
      await this.assertProtectedSlackDestination(
        binding,
        sandbox,
        binding.sandboxId,
      );
    }
    if (!sandbox?.capabilities.snapshots || !sandbox.snapshot) {
      throw new Error("The native T3 worker does not support snapshots");
    }
    const quiesced = await sandbox.process.exec(
      [
        "set -e",
        "if [ -x scripts/compadre-dev-up.sh ]; then scripts/compadre-dev-up.sh down; fi",
        "if [ -s /var/run/t3.pid ]; then",
        "  pid=$(cat /var/run/t3.pid)",
        '  kill "$pid" 2>/dev/null || true',
        '  i=0; while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done',
        '  if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid"; fi',
        "fi",
        "sync",
      ].join("\n"),
      { cwd: sandbox.workspaceRoot ?? "/workspace" },
    );
    if (quiesced.exitCode !== 0) {
      throw new Error(
        `Could not quiesce T3 worker ${binding.sandboxId}: ${quiesced.stderr || quiesced.stdout}`,
      );
    }
    try {
      const snapshot = await sandbox.snapshot(
        `t3-worker-generation-${binding.workerGeneration ?? 1}`,
      );
      return { snapshotId: snapshot.id };
    } catch (error) {
      // Snapshot capture failures leave the sandbox alive but T3 stopped.
      // Restore service before returning the failure so a retry or new message
      // can still reconnect to this generation.
      await (this.dependencies.restart ?? restartManagedT3ModalEnvironment)(
        sandbox,
        { projectId: binding.projectId, t3ThreadId: binding.t3ThreadId },
        this.workerEnvironment(binding),
      ).catch((restartError) => {
        console.error(
          "[t3-worker-lifecycle] restart after snapshot failure failed",
          {
            sandboxId: binding.sandboxId,
            generation: binding.workerGeneration ?? 1,
            errorName:
              restartError instanceof Error
                ? restartError.name
                : typeof restartError,
            errorMessage:
              restartError instanceof Error
                ? restartError.message
                : String(restartError),
          },
        );
      });
      throw error;
    }
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
        throw error;
      }
      marker = undefined;
    }
    if (
      marker?.channelId !== binding.blockedSlackDestination.channelId ||
      marker.threadTs !== binding.blockedSlackDestination.threadTs
    ) {
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
