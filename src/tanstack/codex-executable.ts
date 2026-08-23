/** Resolve the reproducible project-local CLI, with an explicit deploy override. */
export function resolveCodexExecutable(): string {
  return (
    process.env.CODEX_EXECUTABLE ??
    (process.env.COMPADRE_DAYTONA_SKIP_CLI_SETUP === "true"
      ? "codex"
      : `${
          process.env.COMPADRE_DAYTONA_CLI_ROOT?.trim() ||
          "/home/daytona/.compadre-runtime"
        }/node_modules/.bin/codex`)
  );
}
