import { randomUUID } from "node:crypto";
import type { SandboxHandle } from "@tanstack/ai-sandbox";
import { COMPADRE_SKILL_NAMES } from "../compadre-skills.js";
import { gitAuthenticationEnvironment } from "../repo.js";
import { ModalHandle } from "../tanstack/modal-sandbox.js";
import { configuredEnvironmentBridgeToken } from "../tanstack/relay-tool-bridge.js";
import { createHarnessSandbox } from "../tanstack/sandbox-runtime.js";

const DEFAULT_T3_PORT = 3773;
const DEFAULT_T3_BASE_DIR = "/var/lib/t3";
const DEFAULT_T3_LOG = "/var/log/compadre/t3.log";
const STARTUP_TIMEOUT_MS = 120_000;
const T3_INSTALL_ROOT = "/opt/compadre-runtime/node_modules/t3";
const T3_FORK_ARCHIVE = "/tmp/compadre-t3-fork.tgz";

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
  return result;
}

async function configureNativeHarnessAuthentication(
  handle: SandboxHandle,
  providerEnvironment: Record<string, string>,
): Promise<void> {
  if (!providerEnvironment.OPENAI_API_KEY) return;
  const login = await handle.process.exec(
    `printf '%s' "$OPENAI_API_KEY" | setpriv --reuid=node --regid=node --init-groups codex login --with-api-key >/dev/null`,
  );
  if (login.exitCode !== 0) {
    throw new Error(
      `Codex CLI authentication failed: ${login.stderr || login.stdout}`,
    );
  }
}

async function installLocalT3Fork(
  handle: SandboxHandle,
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

async function bootstrapT3Project(
  handle: SandboxHandle,
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
  handle: SandboxHandle,
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

/**
 * Launch T3's native headless server inside an isolated Modal sandbox.
 *
 * This intentionally bypasses Compadre's TanStack harness adapters. TanStack
 * remains only as the existing sandbox provisioning layer for this spike.
 */
export async function launchT3ModalExperiment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<T3ModalExperiment> {
  const port = DEFAULT_T3_PORT;
  const experimentEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    COMPADRE_MODAL_APP:
      environment.COMPADRE_T3_MODAL_APP?.trim() || "compadre-t3-experiment",
  };
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
        experimentEnvironment.COMPADRE_T3_PACKAGE_PATH,
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
      await configureNativeHarnessAuthentication(handle, providerEnvironment);
      await bootstrapT3Project(handle, workspaceRoot);

      const command = [
        "setpriv --reuid=node --regid=node --init-groups t3 serve",
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
  const pairingToken = startupToken as string | undefined;
  if (!pairingToken) {
    await handle.destroy().catch(() => undefined);
    throw new Error("T3 startup completed without issuing a pairing token");
  }
  const channel = await handle.ports.connect(port);
  const baseUrl = channel.url.replace(/\/$/, "");
  return {
    sandboxId: handle.id,
    baseUrl,
    pairingUrl: `${baseUrl}/pair#token=${pairingToken}`,
    workspaceRoot: handle.workspaceRoot ?? "/workspace",
  };
}
