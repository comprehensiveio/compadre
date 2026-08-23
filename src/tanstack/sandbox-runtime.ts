import {
  createSecrets,
  defineSandbox,
  defineWorkspace,
  type SandboxDefinition,
} from "@tanstack/ai-sandbox";
import { configuredRepositoryUrl } from "../repo.js";
import { modalSandboxProvider } from "./modal-sandbox.js";

export function harnessWorkspacePath(
  _localWorktreePath: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return environment.COMPADRE_MODAL_WORKDIR?.trim() || "/workspace";
}

function modalSetupCommands(environment: NodeJS.ProcessEnv): string[] {
  const repositoryUrl = configuredRepositoryUrl(environment);
  const branch = environment.REPO_BRANCH?.trim() || "main";
  const quote = (value: string): string =>
    `'${value.replaceAll("'", `'\\''`)}'`;
  const clone = environment.GITHUB_PERSONAL_ACCESS_TOKEN
    ? `git -c credential.helper='!f() { echo "username=$GIT_ASKPASS_USER"; echo "password=$GIT_ASKPASS_TOKEN"; }; f' clone --depth 1 --single-branch --branch ${quote(branch)} -- ${quote(repositoryUrl)} .`
    : `git clone --depth 1 --single-branch --branch ${quote(branch)} -- ${quote(repositoryUrl)} .`;
  if (environment.COMPADRE_MODAL_SKIP_CLI_SETUP === "true") return [clone];
  const runtimeRoot =
    environment.COMPADRE_MODAL_CLI_ROOT?.trim() || "/opt/compadre-runtime";
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
      provider: modalSandboxProvider({ environment }),
      workspace: defineWorkspace({
        root: workdir,
        // Clone in setup so a non-zero Git exit is surfaced directly.
        source: { type: "none" },
        secrets,
        setup: modalSetupCommands(environment),
      }),
      lifecycle: {
        reuse: reuseThread ? "thread" : "none",
        snapshot: reuseThread ? "after-run" : "none",
        destroyOnComplete: !reuseThread,
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
