import crypto from "node:crypto";
import { log } from "../logging.js";
import { modalSandboxProvider } from "../tanstack/modal-sandbox.js";
import { repositoryCloneCommand } from "../tanstack/sandbox-runtime.js";
import { devBackupAccessProjection } from "./dev-backups.js";
import { devEnvironmentArtifactProjection } from "./dev-environment.js";
import type { MetadataStore } from "./storage.js";

/**
 * A golden worker template: a Modal filesystem snapshot of a fully-warmed
 * comp dev environment (shallow checkout, installed dependencies, restored
 * anonymized production database, Vite cache). Provisioning a new thread
 * restores this image and refreshes the checkout instead of cold-building,
 * which measured 2-3 minutes to a usable environment versus 12-13 minutes
 * cold (2026-09-01, scripts/experiments/cold-start-results.md).
 *
 * The template contains no T3 state and no thread identity: the T3 fork,
 * project bootstrap, credentials, and skills are projected per-thread at
 * launch, exactly like the cold path.
 */
export interface T3WorkerTemplate {
  snapshotId: string;
  repoSha: string;
  backupKey: string;
  builtAt: string;
}

const NAMESPACE = "compadre.t3.worker-template.v1";
const KEY = "current";

export async function readWorkerTemplate(
  metadata: MetadataStore,
): Promise<T3WorkerTemplate | null> {
  const value = (await metadata.get(NAMESPACE, KEY)) as
    | Partial<T3WorkerTemplate>
    | null;
  if (
    !value ||
    typeof value.snapshotId !== "string" ||
    !value.snapshotId.trim() ||
    typeof value.builtAt !== "string"
  ) {
    return null;
  }
  return {
    snapshotId: value.snapshotId,
    repoSha: typeof value.repoSha === "string" ? value.repoSha : "unknown",
    backupKey: typeof value.backupKey === "string" ? value.backupKey : "unknown",
    builtAt: value.builtAt,
  };
}

export async function publishWorkerTemplate(
  metadata: MetadataStore,
  template: T3WorkerTemplate,
): Promise<void> {
  await metadata.set(NAMESPACE, KEY, template);
}

export async function clearWorkerTemplate(
  metadata: MetadataStore,
): Promise<void> {
  await metadata.delete(NAMESPACE, KEY);
}

interface BuildHandle {
  id: string;
  process: {
    exec(
      command: string,
      options?: { env?: Record<string, string> },
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
  env: { set(vars: Record<string, string>): Promise<void> };
  ports: { connect(port: number): Promise<{ url: string }> };
  checkpoint(label?: string): Promise<{ id: string }>;
  destroy(): Promise<void>;
}

async function exec(
  handle: BuildHandle,
  step: string,
  command: string,
): Promise<string> {
  const startedAt = Date.now();
  const result = await handle.process.exec(command);
  const elapsedMs = Date.now() - startedAt;
  if (result.exitCode !== 0) {
    throw new Error(
      `worker template build step "${step}" failed (${result.exitCode}) after ${elapsedMs}ms: ${
        (result.stderr || result.stdout).slice(-2000)
      }`,
    );
  }
  log.info(
    { step, sandboxId: handle.id, elapsedMs },
    "t3 worker template build step",
  );
  return result.stdout;
}

/**
 * Build and publish a fresh worker template. The build runs the same scripts
 * a real thread runs (clone, compadre-dev-up.sh up, compadre-dev-data.sh
 * production-latest), so a build that publishes has by construction proven
 * the environment serves the app with production-derived data. Any failure
 * leaves the previously published template untouched.
 */
export async function buildT3WorkerTemplate(input: {
  metadata: MetadataStore;
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
}): Promise<T3WorkerTemplate> {
  const now = input.now ?? (() => new Date());
  const environment: NodeJS.ProcessEnv = {
    ...(input.environment ?? process.env),
  };
  environment.COMPADRE_MODAL_APP =
    environment.COMPADRE_T3_MODAL_APP?.trim() || "compadre";
  // The scoped backup token is thread-scoped by design; the build sandbox is
  // not a thread, so it gets a throwaway identity for the manifest request.
  environment.COMPADRE_CANONICAL_THREAD_ID = crypto.randomUUID();

  const provider = modalSandboxProvider({
    environment,
    encryptedPorts: [3000],
  });
  const handle = (await provider.create({
    id: `t3-worker-template-${Date.now()}`,
  })) as unknown as BuildHandle;
  log.info({ sandboxId: handle.id }, "t3 worker template build started");
  try {
    const preview = await handle.ports.connect(3000);
    await handle.env.set({
      ...(environment.GITHUB_PERSONAL_ACCESS_TOKEN
        ? {
            GIT_ASKPASS_USER: "x-access-token",
            GIT_ASKPASS_TOKEN: environment.GITHUB_PERSONAL_ACCESS_TOKEN,
            GIT_TERMINAL_PROMPT: "0",
          }
        : {}),
      ...(await devEnvironmentArtifactProjection(environment)),
      ...devBackupAccessProjection(environment),
      COMPADRE_DEV_PREVIEW_URL: preview.url.replace(/\/$/, ""),
      COMPADRE_DEV_PORT: "3000",
      HOME: "/home/node",
    });
    await exec(handle, "repository.clone", repositoryCloneCommand(environment));
    const repoSha = (
      await exec(handle, "repository.sha", "git rev-parse HEAD")
    ).trim();
    await exec(
      handle,
      "dev-up",
      "set -o pipefail; scripts/compadre-dev-up.sh up 2>&1 | tail -20",
    );
    const dataOutput = await exec(
      handle,
      "dev-data.production-latest",
      "set -o pipefail; scripts/compadre-dev-data.sh production-latest 2>&1 | tail -5",
    );
    const backupKey =
      /PRODUCTION_DATA_READY backup=(\S+)/.exec(dataOutput)?.[1] ?? "unknown";
    const checkpoint = await handle.checkpoint("t3-worker-template");
    const template: T3WorkerTemplate = {
      snapshotId: checkpoint.id,
      repoSha,
      backupKey,
      builtAt: now().toISOString(),
    };
    await publishWorkerTemplate(input.metadata, template);
    log.info(
      { ...template, sandboxId: handle.id },
      "t3 worker template published",
    );
    return template;
  } finally {
    await handle.destroy().catch(() => undefined);
  }
}
