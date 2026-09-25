#!/usr/bin/env node
/** Package the bundled server and patched Linux runtime dependencies for Modal. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import serverPackage from "../apps/server/package.json" with { type: "json" };
import { CliArchiveCommandFailedError, stageRuntimeExternals } from "./build-cli-archive.ts";

Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const outputDir = path.resolve(process.argv[2] ?? "release-compadre");
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "compadre-worker-package-" });
  const stageDir = path.join(temporary, "package");
  yield* fs.makeDirectory(stageDir);
  yield* stageRuntimeExternals({
    repoRoot,
    stageDir,
    platform: "linux",
    arch: "x64",
    version: serverPackage.version,
  });
  // node-pty has no Linux prebuild. Compile against the worker's Node ABI,
  // including when this packaging command runs on macOS or a newer Node.
  const nativeBuild = yield* spawner.spawn(
    ChildProcess.make(
      "docker",
      [
        "run",
        "--rm",
        "--platform",
        "linux/amd64",
        "-v",
        `${stageDir}:/package`,
        "-w",
        "/package/node_modules/node-pty",
        "node:22-bookworm",
        "npm",
        "run",
        "install",
      ],
      { stdout: "inherit", stderr: "inherit" },
    ),
  );
  const nativeExitCode = Number(yield* nativeBuild.exitCode);
  if (nativeExitCode !== 0) {
    return yield* new CliArchiveCommandFailedError({
      command: "Linux node-pty build",
      exitCode: nativeExitCode,
    });
  }
  yield* fs.copy(path.join(repoRoot, "apps/server/dist"), path.join(stageDir, "dist"));
  // Modal extracts the archive directly; it does not run an npm installation.
  yield* fs.writeFileString(
    path.join(stageDir, "package.json"),
    yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      name: "t3",
      version: serverPackage.version,
      type: "module",
      private: true,
    }),
  );
  yield* fs.makeDirectory(outputDir, { recursive: true });
  const archive = path.join(outputDir, `t3-${serverPackage.version}.tgz`);
  const child = yield* spawner.spawn(
    ChildProcess.make("tar", ["-czf", archive, "-C", temporary, "package"], {
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  const exitCode = Number(yield* child.exitCode);
  if (exitCode !== 0) return yield* new CliArchiveCommandFailedError({ command: "tar", exitCode });
  yield* Effect.log(archive);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
