import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { COMPADRE_SKILL_NAMES } from "../compadre-skills.js";
import { gitAuthenticationEnvironment } from "../repo.js";
import { ModalHandle } from "../tanstack/modal-sandbox.js";
import { configuredEnvironmentBridgeToken } from "../tanstack/relay-tool-bridge.js";
import { createHarnessSandbox } from "../tanstack/sandbox-runtime.js";
import { exchangeT3PairingToken, type T3Client } from "../t3/client.js";

const DEFAULT_T3_PORT = 3773;
const DEFAULT_T3_BASE_DIR = "/var/lib/t3";
const DEFAULT_T3_LOG = "/var/log/compadre/t3.log";
const STARTUP_TIMEOUT_MS = 120_000;
const T3_INSTALL_ROOT = "/opt/compadre-runtime/node_modules/t3";
const T3_FORK_ARCHIVE = "/tmp/compadre-t3-fork.tgz";
const MAX_T3_FORK_ARCHIVE_BYTES = 50 * 1024 * 1024;
export const T3_GATEWAY_CREDENTIAL_PATH =
  "/var/lib/t3/compadre-gateway-access-token";

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
    result.COMPADRE_MCP_URL = new URL("/internal/t3-mcp", publicUrl).toString();
    result.COMPADRE_MCP_BEARER_TOKEN = bridgeToken;
  }
  for (const name of [
    "DD_API_KEY",
    "DD_SITE",
    "DD_ENV",
    "DD_LLMOBS_ML_APP",
    "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
    "COMPADRE_CANONICAL_THREAD_ID",
    "COMPADRE_PROVIDER_INSTANCE_ID",
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
      environment.T3CODE_OTLP_SERVICE_NAME?.trim() || "compadre-t3-worker";
  }
  return result;
}

async function configureNativeHarnessAuthentication(
  handle: T3SandboxHandle,
): Promise<void> {
  const login = await handle.process.exec(
    [
      'if [ -n "${CODEX_AUTH_JSON_BASE64:-}" ]; then',
      "install -d -m 700 -o node -g node /home/node/.codex &&",
      "printf '%s' \"$CODEX_AUTH_JSON_BASE64\" | base64 -d > /home/node/.codex/auth.json &&",
      "chown node:node /home/node/.codex/auth.json &&",
      "chmod 600 /home/node/.codex/auth.json",
      'elif [ -n "${OPENAI_API_KEY:-}" ]; then',
      `printf '%s' "$OPENAI_API_KEY" | setpriv --reuid=node --regid=node --init-groups codex login --with-api-key >/dev/null`,
      "fi",
    ].join("\n"),
  );
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
  const installed = await handle.process.exec(
    `tar -xzf ${quote(T3_FORK_ARCHIVE)} --strip-components=1 -C ${quote(T3_INSTALL_ROOT)}`,
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
  } = {},
): Promise<string | undefined> {
  const localPath = environment.COMPADRE_T3_PACKAGE_PATH?.trim();
  if (localPath) return localPath;

  const packageUrl = environment.COMPADRE_T3_PACKAGE_URL?.trim();
  if (!packageUrl) return undefined;
  const expectedSha256 = environment.COMPADRE_T3_PACKAGE_SHA256?.trim().toLowerCase();
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

  const response = await (options.fetch ?? globalThis.fetch)(parsed);
  if (!response.ok) {
    throw new Error(`T3 fork download failed with HTTP ${response.status}`);
  }
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_T3_FORK_ARCHIVE_BYTES) {
    throw new Error("T3 fork archive exceeds the 50 MiB limit");
  }
  const archive = new Uint8Array(await response.arrayBuffer());
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
      "setpriv --reuid=node --regid=node --init-groups t3 project add",
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
      if (/EADDRINUSE|address already in use|fatal startup/i.test(lastLog)) break;
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

export interface T3ModalExperiment {
  sandboxId: string;
  baseUrl: string;
  pairingUrl: string;
  workspaceRoot: string;
}

export interface ManagedT3ModalEnvironment extends T3ModalExperiment {
  projectId: string;
  client: T3Client;
}

/**
 * Launch T3's native headless server inside an isolated Modal sandbox.
 *
 * This intentionally bypasses Compadre's TanStack harness adapters. TanStack
 * remains only as the existing sandbox provisioning layer for this spike.
 */
export async function launchManagedT3ModalEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ManagedT3ModalEnvironment> {
  const port = DEFAULT_T3_PORT;
  const experimentEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    COMPADRE_MODAL_APP:
      environment.COMPADRE_T3_MODAL_APP?.trim() || "compadre-t3-experiment",
  };
  const forkArchivePath = await resolveT3ForkArchive(experimentEnvironment);
  let startupToken: string | undefined;
  const sandbox = createHarnessSandbox({
    worktreeId: `t3-modal-${randomUUID()}`,
    localWorktreePath: "/unused",
    reuseThread: true,
    environment: experimentEnvironment,
    encryptedPorts: [port],
    onReady: async (handle) => {
      const workspaceRoot = handle.workspaceRoot ?? "/workspace";
      const providerEnvironment = projectedProviderEnvironment(
        experimentEnvironment,
      );
      await installLocalT3Fork(
        handle,
        forkArchivePath,
      );
      await handle.env.set({
        ...providerEnvironment,
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
      const ownership = await handle.process.exec(
        `chown -R node:node ${quote(workspaceRoot)} ${quote(DEFAULT_T3_BASE_DIR)} ${quote("/var/log/compadre")}`,
      );
      if (ownership.exitCode !== 0) {
        throw new Error(ownership.stderr || ownership.stdout);
      }
      await configureNativeHarnessAuthentication(handle);
      await bootstrapT3Project(handle, workspaceRoot);

      const command = [
        "env -u CODEX_AUTH_JSON_BASE64 setpriv --reuid=node --regid=node --init-groups t3 serve",
        "--host 0.0.0.0",
        `--port ${port}`,
        `--base-dir ${quote(DEFAULT_T3_BASE_DIR)}`,
        "--auto-bootstrap-project-from-cwd",
        "--no-browser",
        quote(workspaceRoot),
      ].join(" ");
      const started = await handle.process.exec(
        `nohup ${command} </dev/null >${quote(DEFAULT_T3_LOG)} 2>&1 & echo $! > /var/run/t3.pid`,
      );
      if (started.exitCode !== 0) {
        throw new Error(started.stderr || started.stdout);
      }
      startupToken = await waitForT3Startup(handle, DEFAULT_T3_LOG);
    },
  });

  const handle = await sandbox.ensure({
    threadId: `t3-modal-${randomUUID()}`,
    runId: randomUUID(),
  });
  try {
    // `ensure()` is the advanced provisioning API. TanStack's chat middleware
    // normally owns lifecycle hooks, so this direct experiment must invoke the
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
    const channel = await handle.ports.connect(port);
    const baseUrl = channel.url.replace(/\/$/, "");
    const gatewaySession = await exchangeT3PairingToken({
      baseUrl,
      pairingToken,
    });
    const snapshot = await gatewaySession.client.snapshot();
    const project = snapshot.projects.find(
      (candidate) =>
        candidate.workspaceRoot === (handle.workspaceRoot ?? "/workspace"),
    );
    if (!project) {
      throw new Error("T3 project bootstrap completed without a workspace project");
    }
    const browserPairing = await gatewaySession.client.mintPairingCredential({
      label: "Compadre experiment browser",
    });
    await handle.fs.write(
      T3_GATEWAY_CREDENTIAL_PATH,
      gatewaySession.accessToken,
    );
    const protectedCredential = await handle.process.exec(
      `chown node:node ${quote(T3_GATEWAY_CREDENTIAL_PATH)} && chmod 600 ${quote(T3_GATEWAY_CREDENTIAL_PATH)}`,
    );
    if (protectedCredential.exitCode !== 0) {
      throw new Error("Could not protect the T3 gateway credential in Modal");
    }
    return {
      sandboxId: handle.id,
      baseUrl,
      pairingUrl: `${baseUrl}/pair#token=${browserPairing.credential}`,
      workspaceRoot: handle.workspaceRoot ?? "/workspace",
      projectId: project.id,
      client: gatewaySession.client,
    };
  } catch (error) {
    await handle.destroy().catch(() => undefined);
    throw error;
  }
}

export async function launchT3ModalExperiment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<T3ModalExperiment> {
  const managed = await launchManagedT3ModalEnvironment(environment);
  return {
    sandboxId: managed.sandboxId,
    baseUrl: managed.baseUrl,
    pairingUrl: managed.pairingUrl,
    workspaceRoot: managed.workspaceRoot,
  };
}
