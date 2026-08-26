import path from "node:path";
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
import {
  context as otelContext,
  metrics,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

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

const MIB = 1024 * 1024;
const MODAL_PROCESS_SAMPLE_INTERVAL_MS = 10_000;
const modalMemoryUsage = metrics
  .getMeter("compadre.runtime")
  .createHistogram("compadre.agent.sandbox.memory.usage", {
    unit: "By",
    description: "Sampled aggregate process RSS inside the agent sandbox",
  });

export interface ModalProcessSample {
  processCount: number;
  rssBytes: number;
  topProcess?: string;
  topProcessRssBytes: number;
}

export function parseModalProcessTable(output: string): ModalProcessSample {
  let processCount = 0;
  let rssBytes = 0;
  let topProcess: string | undefined;
  let topProcessRssBytes = 0;
  for (const line of output.split("\n")) {
    const match = /^\s*\d+\s+\d+\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const processRssBytes = Number(match[1]) * 1024;
    processCount += 1;
    rssBytes += processRssBytes;
    if (processRssBytes > topProcessRssBytes) {
      topProcessRssBytes = processRssBytes;
      topProcess = match[2];
    }
  }
  return { processCount, rssBytes, topProcess, topProcessRssBytes };
}

const DEFAULT_APP_NAME = "compadre";
const DEFAULT_IMAGE = "node:22";
const DEFAULT_WORKDIR = "/workspace";
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
const DEFAULT_SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const CLAUDE_CODE_VERSION = "2.1.222";
const CODEX_VERSION = "0.146.0";
const PNPM_VERSION = "10.34.2";

function positiveNumberSetting(
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

function shellCommand(command: string): string[] {
  return ["bash", "-lc", command];
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Build immutable image layers so per-request setup only clones the repository. */
export function modalImageCommands(environment: NodeJS.ProcessEnv): string[] {
  const workdir = environment.COMPADRE_MODAL_WORKDIR?.trim() || DEFAULT_WORKDIR;
  const runtimeRoot =
    environment.COMPADRE_MODAL_CLI_ROOT?.trim() || "/opt/compadre-runtime";
  return [
    "RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends git ca-certificates curl gh jq postgresql-client ripgrep && rm -rf /var/lib/apt/lists/*",
    `RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate`,
    `RUN mkdir -p ${quote(workdir)} ${quote(runtimeRoot)}`,
    ...(environment.COMPADRE_MODAL_SKIP_CLI_SETUP === "true"
      ? []
      : [
          `RUN npm install --prefix ${quote(runtimeRoot)} --no-save @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @openai/codex@${CODEX_VERSION}`,
          `RUN ln -sf ${quote(path.posix.join(runtimeRoot, "node_modules", ".bin", "claude"))} /usr/local/bin/claude && ln -sf ${quote(path.posix.join(runtimeRoot, "node_modules", ".bin", "codex"))} /usr/local/bin/codex`,
        ]),
  ];
}

/** Share concurrent preparation while allowing a transient failure to retry. */
export function cacheSuccessfulPromise<T>(
  task: () => Promise<T>,
): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => {
    if (cached) return cached;
    const pending = task();
    cached = pending;
    void pending.catch(() => {
      if (cached === pending) cached = undefined;
    });
    return pending;
  };
}

async function timedModalPhase<T>(
  phase: string,
  task: () => Promise<T>,
  logContext: { sandboxId?: string } = {},
): Promise<T> {
  return trace
    .getTracer("compadre.runtime")
    .startActiveSpan(
      `compadre.agent.modal.${phase}`,
      { attributes: { "compadre.phase": `modal.${phase}` } },
      async (span) => {
        const startedAt = Date.now();
        let outcome = "success";
        try {
          return await task();
        } catch (error) {
          outcome = "error";
          span.recordException(error instanceof Error ? error : String(error));
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        } finally {
          const elapsedMs = Date.now() - startedAt;
          span.setAttributes({
            "compadre.outcome": outcome,
            "compadre.phase.duration_ms": elapsedMs,
          });
          span.end();
          console.log("[modal-timing]", {
            traceId: span.spanContext().traceId,
            ...logContext,
            phase,
            outcome,
            elapsedMs,
          });
        }
      },
    );
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
  private readonly stopProcessMonitors = new Set<() => void>();

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
        const result = await this.exec(`mv -- ${quote(from)} ${quote(to)}`);
        if (result.exitCode !== 0)
          throw new Error(result.stderr || result.stdout);
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
    const operation =
      command.startsWith("git ") && command.includes(" clone ")
        ? "repository.clone"
        : undefined;
    const execute = async () =>
      processResult(
        await this.sandbox.exec(shellCommand(command), {
          workdir: options?.cwd ?? this.workspaceRoot,
          env: { ...this.envVars, ...options?.env },
        }),
      );
    return operation
      ? timedModalPhase(operation, execute, { sandboxId: this.id })
      : execute();
  }

  private async spawn(
    command: string,
    options?: ProcessOptions,
  ): Promise<SpawnHandle> {
    if (options?.signal?.aborted) throw options.signal.reason;
    const process = await timedModalPhase(
      "harness.spawn",
      () =>
        this.sandbox.exec(shellCommand(command), {
          workdir: options?.cwd ?? this.workspaceRoot,
          env: { ...this.envVars, ...options?.env },
        }),
      { sandboxId: this.id },
    );
    const startedAt = Date.now();
    const parentContext = otelContext.active();
    const runSpan = trace
      .getTracer("compadre.runtime")
      .startSpan(
        "compadre.agent.modal.harness.run",
        { attributes: { "compadre.phase": "modal.harness.run" } },
        parentContext,
      );
    let peakRssBytes = 0;
    let stopped = false;
    let sampleInFlight = false;
    const sample = async () => {
      if (stopped || sampleInFlight) return;
      sampleInFlight = true;
      try {
        const sampleProcess = await this.sandbox.exec([
          "ps",
          "-eo",
          "pid=,ppid=,rss=,comm=",
        ]);
        const result = await processResult(sampleProcess);
        if (stopped || result.exitCode !== 0) return;
        const observation = parseModalProcessTable(result.stdout);
        peakRssBytes = Math.max(peakRssBytes, observation.rssBytes);
        const attributes = {
          "sandbox.provider": "modal",
          "sandbox.process.count": observation.processCount,
        };
        modalMemoryUsage.record(
          observation.rssBytes,
          { ...attributes, "memory.scope": "sandbox_processes" },
          parentContext,
        );
        runSpan.addEvent("resource_sample", {
          ...attributes,
          "memory.rss_bytes": observation.rssBytes,
          "process.top.name": observation.topProcess ?? "unknown",
          "process.top.rss_bytes": observation.topProcessRssBytes,
        });
        console.log("[modal-process]", {
          traceId: runSpan.spanContext().traceId,
          sandboxId: this.id,
          elapsedMs: Date.now() - startedAt,
          processCount: observation.processCount,
          rssMiB: Math.round(observation.rssBytes / MIB),
          topProcess: observation.topProcess ?? "unknown",
          topRssMiB: Math.round(observation.topProcessRssBytes / MIB),
        });
      } catch (error) {
        console.warn("[modal-process] sample failed", {
          traceId: runSpan.spanContext().traceId,
          sandboxId: this.id,
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      } finally {
        sampleInFlight = false;
      }
    };
    const timer = setInterval(
      () => void sample(),
      MODAL_PROCESS_SAMPLE_INTERVAL_MS,
    );
    timer.unref();
    void sample();
    let finalized = false;
    const cancelMonitor = () => finalizeMonitor("cancelled");
    const finalizeMonitor = (
      outcome: "success" | "error" | "cancelled",
      exitCode?: number,
      error?: unknown,
    ) => {
      if (finalized) return;
      finalized = true;
      stopped = true;
      clearInterval(timer);
      this.stopProcessMonitors.delete(cancelMonitor);
      runSpan.setAttributes({
        "compadre.outcome": outcome,
        "memory.process_tree.peak_rss_bytes": peakRssBytes,
        ...(exitCode === undefined ? {} : { "process.exit.code": exitCode }),
      });
      if (outcome !== "success") {
        const message =
          error instanceof Error
            ? error.message
            : error === undefined
              ? "sandbox cleanup before process exit"
              : String(error);
        if (error !== undefined) {
          runSpan.recordException(
            error instanceof Error ? error : String(error),
          );
        }
        runSpan.setStatus({ code: SpanStatusCode.ERROR, message });
      } else {
        runSpan.setStatus({ code: SpanStatusCode.OK });
      }
      runSpan.end();
      const log = outcome === "success" ? console.log : console.warn;
      log("[modal-process] finalized", {
        traceId: runSpan.spanContext().traceId,
        sandboxId: this.id,
        outcome,
        ...(exitCode === undefined ? {} : { exitCode }),
        elapsedMs: Date.now() - startedAt,
        peakRssMiB: Math.round(peakRssBytes / MIB),
        ...(error === undefined
          ? {}
          : {
              errorName: error instanceof Error ? error.name : typeof error,
              errorMessage:
                error instanceof Error ? error.message : String(error),
            }),
      });
    };
    this.stopProcessMonitors.add(cancelMonitor);
    let waitPromise: Promise<number> | undefined;
    const wait = () => {
      waitPromise ??= process.wait().then(
        (exitCode) => {
          finalizeMonitor(exitCode === 0 ? "success" : "error", exitCode);
          return exitCode;
        },
        (error) => {
          finalizeMonitor("error", undefined, error);
          throw error;
        },
      );
      return waitPromise;
    };
    return {
      pid: -1,
      stdout: streamChunks(process.stdout),
      stderr: streamChunks(process.stderr),
      stdin: {
        write: (data) => process.stdin.writeText(data),
        end: () => process.closeStdin(),
      },
      wait,
      // Modal's JS SDK does not expose per-exec termination. Callers branch on
      // killableProcesses=false when correctness depends on a real kill, but
      // generic cleanup still invokes this method best-effort.
      kill: async () => undefined,
    };
  }

  async snapshot(label?: string): Promise<{ id: string; label?: string }> {
    for (const stop of [...this.stopProcessMonitors]) stop();
    const image = await timedModalPhase(
      "snapshot.capture",
      () =>
        this.sandbox.snapshotFilesystem({
          timeoutMs: 5 * 60 * 1_000,
          ttlMs: this.snapshotTtlMs,
        }),
      { sandboxId: this.id },
    );
    // TanStack records the returned image ID immediately after this call. End
    // the billed compute while retaining that instance-store record so the
    // next turn restores this exact filesystem snapshot.
    await timedModalPhase("sandbox.terminate", () => this.sandbox.terminate(), {
      sandboxId: this.id,
    }).catch((error: unknown) => {
      console.warn("[modal] sandbox termination after snapshot failed", {
        sandboxId: this.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    });
    return { id: image.imageId, ...(label ? { label } : {}) };
  }

  async destroy(): Promise<void> {
    for (const stop of [...this.stopProcessMonitors]) stop();
    await timedModalPhase("sandbox.terminate", () => this.sandbox.terminate(), {
      sandboxId: this.id,
    });
  }
}

export interface ModalSandboxProviderOptions {
  environment?: NodeJS.ProcessEnv;
  client?: ModalClient;
}

interface ModalRuntime {
  client: ModalClient;
  app(): Promise<App>;
  baseImage(): Promise<Image>;
}

let sharedRuntime: { key: string; value: ModalRuntime } | undefined;

function modalRuntime(
  environment: NodeJS.ProcessEnv,
  providedClient?: ModalClient,
): ModalRuntime {
  const appName = environment.COMPADRE_MODAL_APP?.trim() || DEFAULT_APP_NAME;
  const baseImageName =
    environment.COMPADRE_MODAL_BASE_IMAGE?.trim() || DEFAULT_IMAGE;
  const key = JSON.stringify([
    environment.MODAL_TOKEN_ID,
    environment.MODAL_ENVIRONMENT,
    appName,
    baseImageName,
    ...modalImageCommands(environment),
  ]);
  if (!providedClient && sharedRuntime?.key === key) return sharedRuntime.value;

  const client =
    providedClient ??
    new ModalClient({
      tokenId: environment.MODAL_TOKEN_ID,
      tokenSecret: environment.MODAL_TOKEN_SECRET,
      environment: environment.MODAL_ENVIRONMENT,
    });
  const app = cacheSuccessfulPromise(() =>
    client.apps.fromName(appName, { createIfMissing: true }),
  );
  const baseImage = cacheSuccessfulPromise(async () =>
    client.images
      .fromRegistry(baseImageName)
      .dockerfileCommands(modalImageCommands(environment))
      .build(await app()),
  );
  const value: ModalRuntime = {
    client,
    app,
    baseImage,
  };
  if (!providedClient) sharedRuntime = { key, value };
  return value;
}

/** Resolve or build the cached Modal image without creating a billed sandbox. */
export async function prepareModalBaseImage(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ imageId: string }> {
  const image = await modalRuntime(environment).baseImage();
  return { imageId: image.imageId };
}

export function modalResourceSettings(environment: NodeJS.ProcessEnv): {
  timeoutMs: number;
  snapshotTtlMs: number;
  cpu: number;
  cpuLimit: number;
  memoryMiB: number;
  memoryLimitMiB: number;
} {
  return {
    timeoutMs: positiveNumberSetting(
      "COMPADRE_MODAL_TIMEOUT_MS",
      environment.COMPADRE_MODAL_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
    ),
    snapshotTtlMs: positiveNumberSetting(
      "COMPADRE_MODAL_SNAPSHOT_TTL_MS",
      environment.COMPADRE_MODAL_SNAPSHOT_TTL_MS,
      DEFAULT_SNAPSHOT_TTL_MS,
    ),
    cpu: positiveNumberSetting(
      "COMPADRE_MODAL_CPU",
      environment.COMPADRE_MODAL_CPU,
      0.5,
    ),
    cpuLimit: positiveNumberSetting(
      "COMPADRE_MODAL_CPU_LIMIT",
      environment.COMPADRE_MODAL_CPU_LIMIT,
      2,
    ),
    memoryMiB: positiveNumberSetting(
      "COMPADRE_MODAL_MEMORY_MIB",
      environment.COMPADRE_MODAL_MEMORY_MIB,
      2048,
    ),
    memoryLimitMiB: positiveNumberSetting(
      "COMPADRE_MODAL_MEMORY_LIMIT_MIB",
      environment.COMPADRE_MODAL_MEMORY_LIMIT_MIB,
      16384,
    ),
  };
}

export function modalSandboxProvider(
  options: ModalSandboxProviderOptions = {},
): SandboxProvider {
  const environment = options.environment ?? process.env;
  const runtime = modalRuntime(environment, options.client);
  const { client } = runtime;
  const workdir = environment.COMPADRE_MODAL_WORKDIR?.trim() || DEFAULT_WORKDIR;
  const { timeoutMs, snapshotTtlMs, cpu, cpuLimit, memoryMiB, memoryLimitMiB } =
    modalResourceSettings(environment);
  const create = async (
    image: Image,
    id?: string,
    env?: Record<string, string>,
  ) => {
    const sandbox = await timedModalPhase("sandbox.create", async () =>
      client.sandboxes.create(await runtime.app(), image, {
        ...(id ? { name: id } : {}),
        command: ["sleep", "infinity"],
        workdir,
        timeoutMs,
        cpu,
        cpuLimit,
        memoryMiB,
        memoryLimitMiB,
        ...(env ? { env } : {}),
        tags: { managedBy: "compadre" },
      }),
    );
    return new ModalHandle(sandbox, workdir, snapshotTtlMs);
  };

  return {
    name: "modal",
    capabilities: () => MODAL_CAPS,
    create: async (input) => {
      const image = await timedModalPhase("image.resolve", () =>
        runtime.baseImage(),
      );
      return create(image, input.id, input.env);
    },
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
    restoreSnapshot: async (input) => {
      const image = await timedModalPhase("snapshot.resolve", () =>
        client.images.fromId(input.snapshotId),
      );
      return create(image, undefined, input.env);
    },
    destroy: async (input) => {
      try {
        await (await client.sandboxes.fromId(input.id)).terminate();
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
    },
  };
}
