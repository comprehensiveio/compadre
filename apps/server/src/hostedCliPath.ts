// @effect-diagnostics nodeBuiltinImport:off - Entrypoint PATH setup runs before an Effect runtime exists.
import { delimiter, resolve } from "node:path";

export function configureHostedCliPath(
  environment: NodeJS.ProcessEnv,
  workingDirectory = process.cwd(),
): void {
  if (environment.T3CODE_INSTALL_GH_CLI?.trim().toLowerCase() !== "true") return;
  const binDirectory = resolve(workingDirectory, ".compadre", "bin");
  const entries = (environment.PATH ?? "").split(delimiter).filter(Boolean);
  if (entries.includes(binDirectory)) return;
  environment.PATH = [binDirectory, ...entries].join(delimiter);
}
