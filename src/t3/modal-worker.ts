import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { COMPADRE_SKILL_NAMES } from "../compadre-skills.js";
import { gitAuthenticationEnvironment } from "../repo.js";
import {
  ModalHandle,
  modalSandboxProvider,
} from "../tanstack/modal-sandbox.js";
import type { SandboxHandle } from "@tanstack/ai-sandbox";
import {
  configuredEnvironmentBridgeToken,
  scopedEnvironmentBridgeToken,
} from "../tanstack/relay-tool-bridge.js";
import { createHarnessSandbox } from "../tanstack/sandbox-runtime.js";
import { exchangeT3PairingToken, type T3Client } from "../t3/client.js";
import {
  authenticatedDevPreviewUrl,
  COMP_DEV_SERVER_PORT,
  devEnvironmentArtifactProjection,
  devEnvironmentEnabled,
  t3EncryptedPorts,
} from "./dev-environment.js";
import { devBackupAccessProjection } from "./dev-backups.js";

const DEFAULT_T3_PORT = 3773;
const DEFAULT_T3_BASE_DIR = "/var/lib/t3";
const DEFAULT_T3_LOG = "/var/log/compadre/t3.log";
const STARTUP_TIMEOUT_MS = 120_000;
const T3_INSTALL_ROOT = "/opt/compadre-runtime/node_modules/t3";
const T3_FORK_ARCHIVE = "/tmp/compadre-t3-fork.tgz";
const MAX_T3_FORK_ARCHIVE_BYTES = 50 * 1024 * 1024;
const T3_FORK_DOWNLOAD_TIMEOUT_MS = 30_000;
export const T3_GATEWAY_CREDENTIAL_PATH =
  "/var/lib/t3/compadre-gateway-access-token";
export const T3_SLACK_DESTINATION_PATH =
  "/var/lib/t3/compadre-blocked-slack-destination.json";

export interface T3BlockedSlackDestination {
  channelId: string;
  threadTs: string;
}

export function blockedSlackDestinationFromEnvironment(
  environment: NodeJS.ProcessEnv,
): T3BlockedSlackDestination | undefined {
  const channelId = environment.COMPADRE_BLOCKED_SLACK_CHANNEL_ID?.trim();
  const threadTs = environment.COMPADRE_BLOCKED_SLACK_THREAD_TS?.trim();
  return channelId && threadTs ? { channelId, threadTs } : undefined;
}

export function parseT3SlackDestinationMarker(
  value: string,
): T3BlockedSlackDestination | undefined {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const channelId =
      typeof parsed.channelId === "string" ? parsed.channelId.trim() : "";
    const threadTs =
      typeof parsed.threadTs === "string" ? parsed.threadTs.trim() : "";
    return channelId && threadTs ? { channelId, threadTs } : undefined;
  } catch {
    return undefined;
  }
}

interface T3SandboxHandle {
  readonly id: string;
  readonly workspaceRoot?: string;
  readonly process: {
    exec(command: string | string[]): Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>;
  };
  readonly fs: {
    read(path: string): Promise<string>;
    write(path: string, contents: string): Promise<void>;
  };
  readonly env: { set(values: Record<string, string>): Promise<void> };
  readonly ports: { connect(port: number): Promise<{ url: string }> };
  destroy(): Promise<void>;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function projectedProviderEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
  ]) {
    const value = environment[name];
    if (value) result[name] = value;
  }
  if (environment.GITHUB_PERSONAL_ACCESS_TOKEN) {
    result.GH_TOKEN = environment.GITHUB_PERSONAL_ACCESS_TOKEN;
    result.GITHUB_TOKEN = environment.GITHUB_PERSONAL_ACCESS_TOKEN;
    Object.assign(result, gitAuthenticationEnvironment(environment));
  }
  const bridgeToken = configuredEnvironmentBridgeToken(environment);
  const publicUrl = environment.COMPADRE_PUBLIC_URL?.trim();
  if (bridgeToken) {
    if (!publicUrl) {
      throw new Error(
        "COMPADRE_T3_MCP_BEARER_TOKEN/COMPADRE_API_KEY and COMPADRE_PUBLIC_URL must be configured together for the T3 MCP bridge",
      );
    }
    const bridgeUrl = new URL("/internal/t3-mcp", publicUrl);
    const blockedSlackDestination =
      blockedSlackDestinationFromEnvironment(environment);
    if (blockedSlackDestination) {
      bridgeUrl.searchParams.set(
        "slack_channel_id",
        blockedSlackDestination.channelId,
      );
      bridgeUrl.searchParams.set(
        "slack_thread_ts",
        blockedSlackDestination.threadTs,
      );
      result.COMPADRE_MCP_BEARER_TOKEN = scopedEnvironmentBridgeToken(
        bridgeToken,
        blockedSlackDestination,
      );
    } else {
      result.COMPADRE_MCP_BEARER_TOKEN = bridgeToken;
    }
    result.COMPADRE_MCP_URL = bridgeUrl.toString();
  }
  for (const name of [
    "DD_API_KEY",
    "DD_SITE",
    "DD_ENV",
    "DD_LLMOBS_ML_APP",
    "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
    "COMPADRE_CANONICAL_THREAD_ID",
    "COMPADRE_PROVIDER_INSTANCE_ID",
    "COMPADRE_WORKER_GENERATION",
  ]) {
    const value = environment[name]?.trim();
    if (value) result[name] = value;
  }
  const tracesUrl =
    environment.T3CODE_OTLP_TRACES_URL?.trim() ||
    (environment.DD_API_KEY?.trim()
      ? `https://otlp.${environment.DD_SITE?.trim() || "datadoghq.com"}/v1/traces`
      : undefined);
  if (tracesUrl) {
    result.T3CODE_OTLP_TRACES_URL = tracesUrl;
    result.T3CODE_OTLP_SERVICE_NAME =
      environment.T3CODE_OTLP_SERVICE_NAME?.trim() || "compadre-worker";
  }
  // The central T3 environment owns the single logical LLM Observability
  // trace after it receives the worker's full native event stream. Modal still
  // exports ordinary OTel/APM spans as the distinct worker service.
  if (environment.DD_API_KEY?.trim()) {
    result.T3CODE_DD_LLMOBS_EXPORT_ENABLED =
      environment.T3CODE_DD_LLMOBS_EXPORT_ENABLED?.trim() || "false";
  }
  return result;
}

export function nativeHarnessAuthenticationCommand(): string {
  return [
    "set -e",
    "install -d -m 700 -o node -g node /home/node/.codex",
    // T3 runs provider harnesses as sandbox root so Codex can rewrite its
    // config as root during a turn. A filesystem snapshot preserves that
    // ownership; normalize it before the node-user login on every restore.
    "chown -R node:node /home/node/.codex",
    "chmod 700 /home/node/.codex",
    'if [ -n "${CODEX_AUTH_JSON_BASE64:-}" ]; then',
    "printf '%s' \"$CODEX_AUTH_JSON_BASE64\" | base64 -d > /home/node/.codex/auth.json &&",
    "chown node:node /home/node/.codex/auth.json &&",
    "chmod 600 /home/node/.codex/auth.json",
    'elif [ -n "${OPENAI_API_KEY:-}" ]; then',
    `printf '%s' "$OPENAI_API_KEY" | setpriv --reuid=node --regid=node --init-groups codex login --with-api-key >/dev/null`,
    "fi",
  ].join("\n");
}

async function configureNativeHarnessAuthentication(
  handle: T3SandboxHandle,
): Promise<void> {
  const login = await handle.process.exec(nativeHarnessAuthenticationCommand());
  if (login.exitCode !== 0) {
    throw new Error(
      `Codex CLI authentication failed: ${login.stderr || login.stdout}`,
    );
  }
}

async function installLocalT3Fork(
  handle: T3SandboxHandle,
  archivePath: string | undefined,
): Promise<void> {
  if (!archivePath?.trim()) return;
  if (!(handle instanceof ModalHandle)) {
    throw new Error("COMPADRE_T3_PACKAGE_PATH requires a Modal sandbox");
  }
  await handle.copyFromLocal(archivePath, T3_FORK_ARCHIVE);
  const stagedInstallRoot = `${T3_INSTALL_ROOT}.next`;
  const previousInstallRoot = `${T3_INSTALL_ROOT}.previous`;
  const installed = await handle.process.exec(
    [
      `rm -rf ${quote(stagedInstallRoot)} ${quote(previousInstallRoot)}`,
      `mkdir -p ${quote(stagedInstallRoot)}`,
      `tar -xzf ${quote(T3_FORK_ARCHIVE)} --strip-components=1 -C ${quote(stagedInstallRoot)}`,
      `mv ${quote(T3_INSTALL_ROOT)} ${quote(previousInstallRoot)}`,
      `mv ${quote(stagedInstallRoot)} ${quote(T3_INSTALL_ROOT)}`,
      `rm -rf ${quote(previousInstallRoot)}`,
    ].join(" && "),
  );
  if (installed.exitCode !== 0) {
    throw new Error(
      `T3 fork installation failed: ${installed.stderr || installed.stdout}`,
    );
  }
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function resolveT3ForkArchive(
  environment: NodeJS.ProcessEnv,
  options: {
    fetch?: typeof globalThis.fetch;
    cacheDirectory?: string;
    downloadTimeoutMs?: number;
  } = {},
): Promise<string | undefined> {
  const localPath = environment.COMPADRE_T3_PACKAGE_PATH?.trim();
  if (localPath) return localPath;

  const packageUrl = environment.COMPADRE_T3_PACKAGE_URL?.trim();
  if (!packageUrl) return undefined;
  const expectedSha256 =
    environment.COMPADRE_T3_PACKAGE_SHA256?.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 ?? "")) {
    throw new Error(
      "COMPADRE_T3_PACKAGE_SHA256 must be set to a 64-character SHA-256 when COMPADRE_T3_PACKAGE_URL is configured",
    );
  }
  const parsed = new URL(packageUrl);
  if (parsed.protocol !== "https:") {
    throw new Error("COMPADRE_T3_PACKAGE_URL must use HTTPS");
  }
  const cachePath = `${options.cacheDirectory ?? "/tmp"}/compadre-t3-${expectedSha256}.tgz`;
  try {
    const cached = await fs.readFile(cachePath);
    if (sha256(cached) === expectedSha256) return cachePath;
  } catch {
    // Cache misses and stale partial files are replaced below.
  }

  const controller = new AbortController();
  const downloadTimeoutMs =
    options.downloadTimeoutMs ?? T3_FORK_DOWNLOAD_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), downloadTimeoutMs);
  const timedOut = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new Error("T3 fork download timed out")),
      { once: true },
    );
  });
  let archive: Uint8Array;
  try {
    const response = await Promise.race([
      (options.fetch ?? globalThis.fetch)(parsed, {
        signal: controller.signal,
      }),
      timedOut,
    ]);
    if (!response.ok) {
      throw new Error(`T3 fork download failed with HTTP ${response.status}`);
    }
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_T3_FORK_ARCHIVE_BYTES) {
      throw new Error("T3 fork archive exceeds the 50 MiB limit");
    }
    archive = new Uint8Array(
      await Promise.race([response.arrayBuffer(), timedOut]),
    );
  } finally {
    clearTimeout(timeout);
  }
  if (archive.byteLength > MAX_T3_FORK_ARCHIVE_BYTES) {
    throw new Error("T3 fork archive exceeds the 50 MiB limit");
  }
  if (sha256(archive) !== expectedSha256) {
    throw new Error("T3 fork archive SHA-256 does not match the pinned digest");
  }
  await fs.writeFile(cachePath, archive, { mode: 0o600 });
  return cachePath;
}

async function bootstrapT3Project(
  handle: T3SandboxHandle,
  workspaceRoot: string,
): Promise<void> {
  const bootstrap = await handle.process.exec(
    [
      "t3 project add",
      quote(workspaceRoot),
      `--base-dir ${quote(DEFAULT_T3_BASE_DIR)}`,
      `--title ${quote("comp")}`,
    ].join(" "),
  );
  if (bootstrap.exitCode !== 0) {
    throw new Error(
      `T3 project bootstrap failed: ${bootstrap.stderr || bootstrap.stdout}`,
    );
  }
}

export function parseT3StartupToken(log: string): string | undefined {
  return /^Token:\s+([23456789A-HJ-NP-Z]{12})\s*$/m.exec(log)?.[1];
}

function redactT3StartupLog(log: string): string {
  return log
    .replace(/^Token:\s+\S+\s*$/gm, "Token: [redacted]")
    .replace(/(#token=)[^\s]+/g, "$1[redacted]");
}

async function waitForT3Startup(
  handle: T3SandboxHandle,
  logPath: string,
): Promise<string> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastLog = "";
  while (Date.now() < deadline) {
    try {
      lastLog = await handle.fs.read(logPath);
      const token = parseT3StartupToken(lastLog);
      if (token) return token;
      if (/EADDRINUSE|address already in use|fatal startup/i.test(lastLog))
        break;
    } catch {
      // The log is created asynchronously by the background server.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `T3 did not become ready in Modal. Startup log:\n${redactT3StartupLog(lastLog).slice(-4_000)}`,
  );
}

function skillProjectionCommand(workspaceRoot: string): string {
  const skillsRoots = [
    `${workspaceRoot}/.agents/skills`,
    `${workspaceRoot}/.claude/skills`,
  ];
  return [
    ...skillsRoots.flatMap((skillsRoot) => [
      `mkdir -p ${quote(skillsRoot)}`,
      ...COMPADRE_SKILL_NAMES.map(
        (name) =>
          `mkdir -p ${quote(`${skillsRoot}/${name}`)} && cp ${quote(`/opt/compadre-skills/${name}/SKILL.md`)} ${quote(`${skillsRoot}/${name}/SKILL.md`)}`,
      ),
    ]),
  ].join(" && ");
}

export interface T3ModalWorker {
  sandboxId: string;
  baseUrl: string;
  pairingUrl: string;
  workspaceRoot: string;
}

export interface ManagedT3ModalEnvironment extends T3ModalWorker {
  projectId: string;
  client: T3Client;
  handle: SandboxHandle;
}

export interface RestoredT3ModalEnvironmentIdentity {
  snapshotId: string;
  projectId: string;
  t3ThreadId: string;
}

async function projectWorkerRuntimeEnvironment(
  handle: T3SandboxHandle,
  workerEnvironment: NodeJS.ProcessEnv,
): Promise<void> {
  const workspaceRoot = handle.workspaceRoot ?? "/workspace";
  const devArtifactEnvironment =
    await devEnvironmentArtifactProjection(workerEnvironment);
  const devBackupEnvironment = devBackupAccessProjection(workerEnvironment);
  const devPreviewEnvironment: Record<string, string> = devEnvironmentEnabled(
    workerEnvironment,
  )
    ? {
        COMPADRE_DEV_PREVIEW_URL:
          authenticatedDevPreviewUrl(workerEnvironment) ??
          (await handle.ports.connect(COMP_DEV_SERVER_PORT)).url.replace(
            /\/$/,
            "",
          ),
        COMPADRE_DEV_PORT: String(COMP_DEV_SERVER_PORT),
        AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
      }
    : {};
  await handle.env.set({
    ...projectedProviderEnvironment(workerEnvironment),
    ...devArtifactEnvironment,
    ...devBackupEnvironment,
    ...devPreviewEnvironment,
    HOME: "/home/node",
  });
  const projected = await handle.process.exec(
    skillProjectionCommand(workspaceRoot),
  );
  if (projected.exitCode !== 0) {
    throw new Error(projected.stderr || projected.stdout);
  }
  const prepare = await handle.process.exec(
    `mkdir -p ${quote(DEFAULT_T3_BASE_DIR)} ${quote("/var/log/compadre")}`,
  );
  if (prepare.exitCode !== 0) {
    throw new Error(prepare.stderr || prepare.stdout);
  }
  await configureNativeHarnessAuthentication(handle);
}

export function t3ServerLaunchCommands(workspaceRoot: string): {
  cleanup: string;
  launch: string;
} {
  const command = [
    "env -u CODEX_AUTH_JSON_BASE64 t3 serve",
    "--host 0.0.0.0",
    `--port ${DEFAULT_T3_PORT}`,
    `--base-dir ${quote(DEFAULT_T3_BASE_DIR)}`,
    "--auto-bootstrap-project-from-cwd",
    "--no-browser",
    quote(workspaceRoot),
  ].join(" ");
  return {
    cleanup: `rm -f ${quote(DEFAULT_T3_LOG)} /var/run/t3.pid`,
    launch: `nohup ${command} </dev/null >${quote(DEFAULT_T3_LOG)} 2>&1 & echo $! > /var/run/t3.pid`,
  };
}

async function startT3Server(
  handle: T3SandboxHandle,
  workspaceRoot: string,
): Promise<string> {
  // A filesystem snapshot retains the old log and pid file, but Modal does not
  // retain processes. Clear both before waiting for this generation's token.
  const commands = t3ServerLaunchCommands(workspaceRoot);
  const cleaned = await handle.process.exec(commands.cleanup);
  if (cleaned.exitCode !== 0) {
    throw new Error(cleaned.stderr || cleaned.stdout);
  }
  const started = await handle.process.exec(commands.launch);
  if (started.exitCode !== 0) {
    throw new Error(started.stderr || started.stdout);
  }
  return waitForT3Startup(handle, DEFAULT_T3_LOG);
}

async function connectManagedT3Environment(input: {
  handle: T3SandboxHandle;
  startupToken: string;
  expectedProjectId?: string;
  expectedThreadId?: string;
}): Promise<ManagedT3ModalEnvironment> {
  const workspaceRoot = input.handle.workspaceRoot ?? "/workspace";
  const channel = await input.handle.ports.connect(DEFAULT_T3_PORT);
  const baseUrl = channel.url.replace(/\/$/, "");
  const gatewaySession = await exchangeT3PairingToken({
    baseUrl,
    pairingToken: input.startupToken,
  });
  const snapshot = await gatewaySession.client.snapshot();
  const project = input.expectedProjectId
    ? snapshot.projects.find(
        (candidate) => candidate.id === input.expectedProjectId,
      )
    : snapshot.projects.find(
        (candidate) => candidate.workspaceRoot === workspaceRoot,
      );
  if (!project) {
    throw new Error(
      input.expectedProjectId
        ? "Restored T3 worker no longer contains its assigned project"
        : "T3 project bootstrap completed without a workspace project",
    );
  }
  if (
    input.expectedThreadId &&
    !snapshot.threads.some((thread) => thread.id === input.expectedThreadId)
  ) {
    throw new Error(
      "Restored T3 worker no longer contains its assigned thread",
    );
  }
  const browserPairing = await gatewaySession.client.mintPairingCredential({
    label: "Compadre native T3 worker",
  });
  await input.handle.fs.write(
    T3_GATEWAY_CREDENTIAL_PATH,
    gatewaySession.accessToken,
  );
  const protectedCredential = await input.handle.process.exec(
    `chown node:node ${quote(T3_GATEWAY_CREDENTIAL_PATH)} && chmod 600 ${quote(T3_GATEWAY_CREDENTIAL_PATH)}`,
  );
  if (protectedCredential.exitCode !== 0) {
    throw new Error("Could not protect the T3 gateway credential in Modal");
  }
  return {
    sandboxId: input.handle.id,
    baseUrl,
    pairingUrl: `${baseUrl}/pair#token=${browserPairing.credential}`,
    workspaceRoot,
    projectId: project.id,
    client: gatewaySession.client,
    handle: input.handle as SandboxHandle,
  };
}

/**
 * Launch T3's native headless server inside an isolated Modal sandbox.
 *
 * This intentionally bypasses Compadre's TanStack harness adapters. TanStack
 * remains only as the existing sandbox provisioning adapter.
 */
export async function launchManagedT3ModalEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ManagedT3ModalEnvironment> {
  const workerEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    COMPADRE_MODAL_APP: environment.COMPADRE_T3_MODAL_APP?.trim() || "compadre",
  };
  const forkArchivePath = await resolveT3ForkArchive(workerEnvironment);
  let startupToken: string | undefined;
  const sandbox = createHarnessSandbox({
    worktreeId: `t3-modal-${randomUUID()}`,
    localWorktreePath: "/unused",
    reuseThread: true,
    environment: workerEnvironment,
    encryptedPorts: t3EncryptedPorts(workerEnvironment),
    onReady: async (handle) => {
      const workspaceRoot = handle.workspaceRoot ?? "/workspace";
      await installLocalT3Fork(handle, forkArchivePath);
      await projectWorkerRuntimeEnvironment(handle, workerEnvironment);
      const blockedSlackDestination =
        blockedSlackDestinationFromEnvironment(workerEnvironment);
      if (blockedSlackDestination) {
        await handle.fs.write(
          T3_SLACK_DESTINATION_PATH,
          JSON.stringify(blockedSlackDestination),
        );
      }
      await bootstrapT3Project(handle, workspaceRoot);

      // Modal enforces no_new_privs, so a process dropped to `node` cannot
      // later start the stopped Postgres/Redis services. The per-thread Modal
      // sandbox is the security boundary; keep T3 and its harnesses on the
      // sandbox root identity so lazy dev startup remains possible.
      startupToken = await startT3Server(handle, workspaceRoot);
    },
  });

  const handle = await sandbox.ensure({
    threadId: `t3-modal-${randomUUID()}`,
    runId: randomUUID(),
  });
  try {
    // `ensure()` is the advanced provisioning API. TanStack's chat middleware
    // normally owns lifecycle hooks, so this direct worker launch must invoke the
    // ready hook after the workspace bootstrap itself.
    await sandbox.hooks?.onReady?.(handle);
  } catch (error) {
    await handle.destroy().catch(() => undefined);
    throw error;
  }
  try {
    const pairingToken = startupToken as string | undefined;
    if (!pairingToken) {
      throw new Error("T3 startup completed without issuing a pairing token");
    }
    return await connectManagedT3Environment({
      handle,
      startupToken: pairingToken,
    });
  } catch (error) {
    await handle.destroy().catch(() => undefined);
    throw error;
  }
}

/**
 * Create a new billed sandbox from a suspended worker's filesystem image.
 * Modal snapshots retain files, not processes, so credentials are reprojected
 * and the headless T3 server is started as a fresh process generation.
 */
export async function restoreManagedT3ModalEnvironment(
  identity: RestoredT3ModalEnvironmentIdentity,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ManagedT3ModalEnvironment> {
  const workerEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    COMPADRE_MODAL_APP: environment.COMPADRE_T3_MODAL_APP?.trim() || "compadre",
  };
  // A filesystem snapshot contains the T3 package that was current when the
  // thread hibernated. Reinstall the controller's currently pinned fork before
  // starting it so resumed threads receive runtime fixes just like new ones.
  const forkArchivePath = await resolveT3ForkArchive(workerEnvironment);
  const provider = modalSandboxProvider({
    environment: workerEnvironment,
    encryptedPorts: t3EncryptedPorts(workerEnvironment),
  });
  if (!provider.restoreSnapshot) {
    throw new Error("The Modal sandbox provider does not support restoration");
  }
  const handle = (await provider.restoreSnapshot({
    snapshotId: identity.snapshotId,
  })) as T3SandboxHandle;
  try {
    await installLocalT3Fork(handle, forkArchivePath);
    await projectWorkerRuntimeEnvironment(handle, workerEnvironment);
    const startupToken = await startT3Server(
      handle,
      handle.workspaceRoot ?? "/workspace",
    );
    return await connectManagedT3Environment({
      handle,
      startupToken,
      expectedProjectId: identity.projectId,
      expectedThreadId: identity.t3ThreadId,
    });
  } catch (error) {
    await handle.destroy().catch(() => undefined);
    throw error;
  }
}

/** Best-effort recovery when a filesystem capture fails after T3 was stopped. */
export async function restartManagedT3ModalEnvironment(
  handle: SandboxHandle,
  identity: Omit<RestoredT3ModalEnvironmentIdentity, "snapshotId">,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ManagedT3ModalEnvironment> {
  const typedHandle = handle as T3SandboxHandle;
  await projectWorkerRuntimeEnvironment(typedHandle, environment);
  const startupToken = await startT3Server(
    typedHandle,
    typedHandle.workspaceRoot ?? "/workspace",
  );
  return connectManagedT3Environment({
    handle: typedHandle,
    startupToken,
    expectedProjectId: identity.projectId,
    expectedThreadId: identity.t3ThreadId,
  });
}

export async function launchT3ModalWorker(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<T3ModalWorker> {
  const managed = await launchManagedT3ModalEnvironment(environment);
  return {
    sandboxId: managed.sandboxId,
    baseUrl: managed.baseUrl,
    pairingUrl: managed.pairingUrl,
    workspaceRoot: managed.workspaceRoot,
  };
}
