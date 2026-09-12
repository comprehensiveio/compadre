// @effect-diagnostics nodeBuiltinImport:off - Entrypoint PATH setup runs before an Effect runtime exists.
import * as NodePath from "node:path";

export function configureHostedCliPath(
  environment: NodeJS.ProcessEnv,
  workingDirectory = process.cwd(),
): void {
  if (environment.T3CODE_INSTALL_GH_CLI?.trim().toLowerCase() !== "true") return;
  const binDirectory = NodePath.resolve(workingDirectory, ".compadre", "bin");
  const entries = (environment.PATH ?? "").split(NodePath.delimiter).filter(Boolean);
  if (entries.includes(binDirectory)) return;
  environment.PATH = [binDirectory, ...entries].join(NodePath.delimiter);
}
