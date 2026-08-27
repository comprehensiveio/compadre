import { assert, it } from "@effect/vitest";
// @effect-diagnostics nodeBuiltinImport:off - Mirrors the entrypoint's process PATH delimiter.
import { delimiter, resolve } from "node:path";

import { configureHostedCliPath } from "./hostedCliPath.ts";

it("prepends the fork-managed CLI directory for hosted deployments", () => {
  const environment = { T3CODE_INSTALL_GH_CLI: "true", PATH: "/usr/bin" };
  configureHostedCliPath(environment, "/srv/t3code");
  assert.equal(environment.PATH, `${resolve("/srv/t3code/.compadre/bin")}${delimiter}/usr/bin`);

  configureHostedCliPath(environment, "/srv/t3code");
  assert.equal(environment.PATH, `${resolve("/srv/t3code/.compadre/bin")}${delimiter}/usr/bin`);
});

it("leaves ordinary T3 runtimes unchanged", () => {
  const environment = { PATH: "/usr/bin" };
  configureHostedCliPath(environment, "/srv/t3code");
  assert.equal(environment.PATH, "/usr/bin");
});
