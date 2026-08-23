import {
  ModalClient,
  NotFoundError,
  SandboxFilesystemNotFoundError,
  type App,
  type ContainerProcess,
  type Image,
  type Sandbox,
} from "modal";
import {
  UnsupportedCapabilityError,
  createExecBackedGit,
  type ExecResult,
  type ProcessOptions,
  type SandboxCapabilities,
  type SandboxHandle,
  type SandboxProvider,
  type SpawnHandle,
} from "@tanstack/ai-sandbox";

export const MODAL_CAPS: SandboxCapabilities = {
  fs: true,
  exec: true,
  env: true,
  ports: false,
  backgroundProcesses: true,
  // Modal exposes a stdin stream, but a real persistent-shell probe showed
  // commands written after exec can remain buffered indefinitely. Force the
  // TanStack bootstrap and harnesses onto their file/exec-backed delivery path.
  writableStdin: false,
  killableProcesses: false,
  snapshots: true,
  networkPolicy: false,
  durableFilesystem: false,
  fork: false,
};

const DEFAULT_APP_NAME = "compadre";
const DEFAULT_IMAGE = "node:22";
const DEFAULT_WORKDIR = "/workspace";
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
const DEFAULT_SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

function shellCommand(command: string): string[] {
  return ["bash", "-lc", command];
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function processResult(
  process: ContainerProcess<string>,
): Promise<ExecResult> {
  const [stdout, stderr, exitCode] = await Promise.all([
    process.stdout.readText(),
    process.stderr.readText(),
    process.wait(),
  ]);
  return { stdout, stderr, exitCode };
}

function streamChunks(stream: ReadableStream<string>): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      const reader = stream.getReader();
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) return;
          if (result.value) yield result.value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}

export class ModalHandle implements SandboxHandle {
  readonly provider = "modal";
  readonly capabilities = MODAL_CAPS;
  readonly id: string;
  readonly workspaceRoot: string;
  readonly fs: SandboxHandle["fs"];
  readonly git: SandboxHandle["git"];
  readonly process: SandboxHandle["process"];
  readonly ports: SandboxHandle["ports"];
  readonly env: SandboxHandle["env"];

  private readonly envVars: Record<string, string> = {};

  constructor(
    private readonly sandbox: Sandbox,
    workdir = DEFAULT_WORKDIR,
    private readonly snapshotTtlMs = DEFAULT_SNAPSHOT_TTL_MS,
  ) {
    this.id = sandbox.sandboxId;
    this.workspaceRoot = workdir;

    this.process = {
      exec: (command, options) => this.exec(command, options),
      spawn: (command, options) => this.spawn(command, options),
    };
    this.fs = {
      read: (path) => sandbox.filesystem.readText(path),
      readBytes: (path) => sandbox.filesystem.readBytes(path),
      write: async (path, data) => {
        if (typeof data === "string") {
          await sandbox.filesystem.writeText(data, path);
        } else {
          await sandbox.filesystem.writeBytes(data, path);
        }
      },
      list: async (path) =>
        (await sandbox.filesystem.listFiles(path)).map((entry) => ({
          name: entry.name,
          path: entry.path,
          type: entry.type === "directory" ? "dir" : "file",
        })),
      mkdir: async (path) => {
        await sandbox.filesystem.makeDirectory(path);
      },
      remove: async (path) => {
        await sandbox.filesystem.remove(path, { recursive: true });
      },
      rename: async (from, to) => {
        const result = await this.exec(
          `mv -- ${quote(from)} ${quote(to)}`,
        );
        if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
      },
      exists: async (path) => {
        try {
          await sandbox.filesystem.stat(path);
          return true;
        } catch (error) {
          if (
            error instanceof SandboxFilesystemNotFoundError ||
            error instanceof NotFoundError
          ) {
            return false;
          }
          throw error;
        }
      },
    };
    this.git = createExecBackedGit(this.process, workdir);
    this.ports = {
      connect: async () => {
        throw new UnsupportedCapabilityError("modal", "ports");
      },
    };
    this.env = {
      set: async (vars) => {
        Object.assign(this.envVars, vars);
      },
    };
  }

  private async exec(
    command: string,
    options?: ProcessOptions,
  ): Promise<ExecResult> {
    if (options?.signal?.aborted) throw options.signal.reason;
    return processResult(
      await this.sandbox.exec(shellCommand(command), {
        workdir: options?.cwd ?? this.workspaceRoot,
        env: { ...this.envVars, ...options?.env },
      }),
    );
  }

  private async spawn(
    command: string,
    options?: ProcessOptions,
  ): Promise<SpawnHandle> {
    if (options?.signal?.aborted) throw options.signal.reason;
    const process = await this.sandbox.exec(shellCommand(command), {
      workdir: options?.cwd ?? this.workspaceRoot,
      env: { ...this.envVars, ...options?.env },
    });
    return {
      pid: -1,
      stdout: streamChunks(process.stdout),
      stderr: streamChunks(process.stderr),
      stdin: {
        write: (data) => process.stdin.writeText(data),
        end: () => process.closeStdin(),
      },
      wait: () => process.wait(),
      // Modal's JS SDK does not expose per-exec termination. Callers branch on
      // killableProcesses=false when correctness depends on a real kill, but
      // generic cleanup still invokes this method best-effort.
      kill: async () => undefined,
    };
  }

  async snapshot(label?: string): Promise<{ id: string; label?: string }> {
    const image = await this.sandbox.snapshotFilesystem({
      timeoutMs: 5 * 60 * 1_000,
      ttlMs: this.snapshotTtlMs,
    });
    // TanStack records the returned image ID immediately after this call. End
    // the billed compute while retaining that instance-store record so the
    // next turn restores this exact filesystem snapshot.
    await this.sandbox.terminate().catch((error: unknown) => {
      console.warn("[modal] sandbox termination after snapshot failed", {
        sandboxId: this.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    });
    return { id: image.imageId, ...(label ? { label } : {}) };
  }

  async destroy(): Promise<void> {
    await this.sandbox.terminate();
  }
}

export interface ModalSandboxProviderOptions {
  environment?: NodeJS.ProcessEnv;
  client?: ModalClient;
}

export function modalSandboxProvider(
  options: ModalSandboxProviderOptions = {},
): SandboxProvider {
  const environment = options.environment ?? process.env;
  const client =
    options.client ??
    new ModalClient({
      tokenId: environment.MODAL_TOKEN_ID,
      tokenSecret: environment.MODAL_TOKEN_SECRET,
      environment: environment.MODAL_ENVIRONMENT,
    });
  const appName = environment.COMPADRE_MODAL_APP?.trim() || DEFAULT_APP_NAME;
  const workdir = environment.COMPADRE_MODAL_WORKDIR?.trim() || DEFAULT_WORKDIR;
  const timeoutMs = Number.parseInt(
    environment.COMPADRE_MODAL_TIMEOUT_MS?.trim() || String(DEFAULT_TIMEOUT_MS),
    10,
  );
  const snapshotTtlMs = Number.parseInt(
    environment.COMPADRE_MODAL_SNAPSHOT_TTL_MS?.trim() ||
      String(DEFAULT_SNAPSHOT_TTL_MS),
    10,
  );
  let appPromise: Promise<App> | undefined;
  let imagePromise: Promise<Image> | undefined;
  const app = () =>
    (appPromise ??= client.apps.fromName(appName, { createIfMissing: true }));
  const baseImage = () =>
    (imagePromise ??= (async () => {
      const blueprint = client.images
        .fromRegistry(
          environment.COMPADRE_MODAL_BASE_IMAGE?.trim() || DEFAULT_IMAGE,
        )
        .dockerfileCommands([
          "RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends git ca-certificates curl && rm -rf /var/lib/apt/lists/*",
          `RUN mkdir -p ${quote(workdir)} ${quote(environment.COMPADRE_MODAL_CLI_ROOT?.trim() || "/opt/compadre-runtime")}`,
        ]);
      return blueprint.build(await app());
    })());
  const create = async (image: Image, id?: string, env?: Record<string, string>) => {
    const sandbox = await client.sandboxes.create(await app(), image, {
      ...(id ? { name: id } : {}),
      command: ["sleep", "infinity"],
      workdir,
      timeoutMs,
      cpu: Number(environment.COMPADRE_MODAL_CPU || "0.5"),
      cpuLimit: Number(environment.COMPADRE_MODAL_CPU_LIMIT || "2"),
      memoryMiB: Number(environment.COMPADRE_MODAL_MEMORY_MIB || "2048"),
      memoryLimitMiB: Number(
        environment.COMPADRE_MODAL_MEMORY_LIMIT_MIB || "8192",
      ),
      ...(env ? { env } : {}),
      tags: { managedBy: "compadre" },
    });
    return new ModalHandle(sandbox, workdir, snapshotTtlMs);
  };

  return {
    name: "modal",
    capabilities: () => MODAL_CAPS,
    create: async (input) => create(await baseImage(), input.id, input.env),
    resume: async (input) => {
      try {
        const sandbox = await client.sandboxes.fromId(input.id);
        if ((await sandbox.poll()) !== null) return null;
        return new ModalHandle(sandbox, workdir, snapshotTtlMs);
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },
    restoreSnapshot: async (input) =>
      create(await client.images.fromId(input.snapshotId), undefined, input.env),
    destroy: async (input) => {
      try {
        await (await client.sandboxes.fromId(input.id)).terminate();
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
    },
  };
}
