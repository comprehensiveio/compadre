import {
  createSecrets,
  defineSandbox,
  defineWorkspace,
  type SandboxDefinition,
} from "@tanstack/ai-sandbox";
import {
  DAYTONA_CAPS,
  DaytonaHandle,
} from "@tanstack/ai-sandbox-daytona";
import { Daytona, type DaytonaConfig } from "@daytona/sdk";
import type {
  SandboxCreateInput,
  SandboxDestroyInput,
  SandboxProvider,
  SandboxResumeInput,
} from "@tanstack/ai-sandbox";
import { configuredRepositoryUrl } from "../repo.js";

export function harnessWorkspacePath(
  _localWorktreePath: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return environment.COMPADRE_DAYTONA_WORKDIR?.trim() || "/home/daytona/workspace";
}

function daytonaSetupCommands(environment: NodeJS.ProcessEnv): string[] {
  const repositoryUrl = configuredRepositoryUrl(environment);
  const branch = environment.REPO_BRANCH?.trim() || "main";
  const quote = (value: string): string =>
    `'${value.replaceAll("'", `'\\''`)}'`;
  const clone = environment.GITHUB_PERSONAL_ACCESS_TOKEN
    ? `git -c credential.helper='!f() { echo "username=$GIT_ASKPASS_USER"; echo "password=$GIT_ASKPASS_TOKEN"; }; f' clone --depth 1 --single-branch --branch ${quote(branch)} -- ${quote(repositoryUrl)} .`
    : `git clone --depth 1 --single-branch --branch ${quote(branch)} -- ${quote(repositoryUrl)} .`;
  if (environment.COMPADRE_DAYTONA_SKIP_CLI_SETUP === "true") return [clone];
  const runtimeRoot =
    environment.COMPADRE_DAYTONA_CLI_ROOT?.trim() ||
    "/home/daytona/.compadre-runtime";
  return [
    clone,
    `npm install --prefix ${JSON.stringify(runtimeRoot)} --no-save @anthropic-ai/claude-code@2.1.222 @openai/codex@0.146.0`,
  ];
}

export interface CreateHarnessSandboxOptions {
  worktreeId: string;
  localWorktreePath: string;
  reuseThread?: boolean;
  environment?: NodeJS.ProcessEnv;
  uploads?: Array<{ path: string; data: Uint8Array }>;
}

function daytonaConfig(environment: NodeJS.ProcessEnv): DaytonaConfig {
  return {
    apiKey: environment.DAYTONA_API_KEY,
    apiUrl: environment.DAYTONA_API_URL,
    target: environment.DAYTONA_TARGET,
  };
}

function daytonaAutoStopMinutes(environment: NodeJS.ProcessEnv): number {
  const raw = environment.COMPADRE_DAYTONA_AUTO_STOP_MINUTES?.trim() || "40";
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 36) {
    throw new Error(
      "COMPADRE_DAYTONA_AUTO_STOP_MINUTES must be an integer of at least 36",
    );
  }
  return value;
}

function daytonaAutoDeleteMinutes(environment: NodeJS.ProcessEnv): number {
  const raw = environment.COMPADRE_DAYTONA_AUTO_DELETE_MINUTES?.trim() || "10080";
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 60) {
    throw new Error(
      "COMPADRE_DAYTONA_AUTO_DELETE_MINUTES must be an integer of at least 60",
    );
  }
  return value;
}

function isTransientDaytonaError(error: unknown): boolean {
  const status =
    error && typeof error === "object" && "statusCode" in error
      ? Number(error.statusCode)
      : undefined;
  return status === 429 || (status !== undefined && status >= 500);
}

async function withDaytonaRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientDaytonaError(error) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
  throw lastError;
}

function isDaytonaNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "statusCode" in error &&
      Number(error.statusCode) === 404,
  );
}

function managedDaytonaProvider(
  environment: NodeJS.ProcessEnv,
): SandboxProvider {
  const autoStopMinutes = daytonaAutoStopMinutes(environment);
  const autoDeleteMinutes = daytonaAutoDeleteMinutes(environment);
  const config = daytonaConfig(environment);
  const daytona = new Daytona(config);
  const workdir = harnessWorkspacePath("/unused", environment);
  return {
    name: "daytona",
    capabilities: () => DAYTONA_CAPS,
    async create(input: SandboxCreateInput) {
      const sandbox = await withDaytonaRetry(() =>
        daytona.create({
          name: input.id,
          language: "typescript",
          snapshot: environment.COMPADRE_DAYTONA_SNAPSHOT,
          ...(input.env ? { envVars: input.env } : {}),
          labels: { "compadre.managed": "true" },
          autoStopInterval: autoStopMinutes,
          autoDeleteInterval: autoDeleteMinutes,
          ephemeral: false,
        }),
      );
      const quotedWorkdir = `'${workdir.replaceAll("'", `'\\''`)}'`;
      const prepared = await sandbox.process.executeCommand(
        `mkdir -p ${quotedWorkdir}`,
      );
      if (prepared.exitCode !== 0) {
        await withDaytonaRetry(() => daytona.delete(sandbox)).catch(
          () => undefined,
        );
        throw new Error(
          `Daytona workspace creation exited ${prepared.exitCode}: ${prepared.result.slice(-1_000)}`,
        );
      }
      return new DaytonaHandle({ sandbox, workdir });
    },
    async resume(input: SandboxResumeInput) {
      try {
        const sandbox = await withDaytonaRetry(() => daytona.get(input.id));
        if (sandbox.state !== "started") {
          await withDaytonaRetry(() => sandbox.start());
        }
        return new DaytonaHandle({ sandbox, workdir });
      } catch (error) {
        if (isDaytonaNotFound(error)) return null;
        throw error;
      }
    },
    async destroy(input: SandboxDestroyInput) {
      try {
        const sandbox = await withDaytonaRetry(() => daytona.get(input.id));
        await withDaytonaRetry(() => daytona.delete(sandbox));
      } catch (error) {
        if (!isDaytonaNotFound(error)) throw error;
      }
    },
  };
}

/** Build the provider-neutral harness boundary used by Claude Code and Codex. */
export function createHarnessSandbox({
  worktreeId,
  localWorktreePath,
  reuseThread = true,
  environment = process.env,
  uploads = [],
}: CreateHarnessSandboxOptions): SandboxDefinition {
  const workdir = harnessWorkspacePath(localWorktreePath, environment);
  const secrets = createSecrets({
      ...(environment.GITHUB_PERSONAL_ACCESS_TOKEN
        ? {
            GIT_ASKPASS_USER: "x-access-token",
            GIT_ASKPASS_TOKEN: environment.GITHUB_PERSONAL_ACCESS_TOKEN,
            GIT_TERMINAL_PROMPT: "0",
          }
        : {}),
    });
  return defineSandbox({
      id: `compadre-agui-${worktreeId}`,
      provider: managedDaytonaProvider(environment),
      workspace: defineWorkspace({
        root: workdir,
        // Clone in setup so a non-zero Git exit is surfaced. The Daytona
        // provider version compatible with this repository does not propagate
        // failures from its exec-backed git.clone implementation.
        source: { type: "none" },
        secrets,
        setup: daytonaSetupCommands(environment),
      }),
      lifecycle: {
        reuse: reuseThread ? "thread" : "none",
        snapshot: "none",
        ...(reuseThread
          ? {
              keepAlive: `${daytonaAutoStopMinutes(environment)}m`,
              destroyOnComplete: false,
            }
          : { destroyOnComplete: true }),
      },
      hooks: {
        onReady: async (handle) => {
          for (const upload of uploads) {
            await handle.fs.write(upload.path, upload.data);
          }
        },
      },
      fileEvents: false,
  });
}
