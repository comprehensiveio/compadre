/* oxlint-disable t3code/no-global-process-runtime -- Install bootstrap runs before dependencies and the Effect runtime are available. */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const VERSION = "2.98.0";
const RELEASES = {
  x64: {
    architecture: "amd64",
    sha256: "3b8ac6b30336802fc1a858d7c084e11cdf24ac1a761ca90b68022d7d729208de",
  },
  arm64: {
    architecture: "arm64",
    sha256: "cf689084f3a3618f7eae4a2420d335d74626d65f5e594b9828d125d69f800d86",
  },
};
const repositoryRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
const binDirectory = NodePath.join(repositoryRoot, ".compadre", "bin");
const target = NodePath.join(binDirectory, "gh");

function installedVersion() {
  try {
    return NodeChildProcess.execFileSync(target, ["--version"], { encoding: "utf8" })
      .split("\n", 1)[0]
      ?.trim();
  } catch {
    return undefined;
  }
}

if (process.env.T3CODE_INSTALL_GH_CLI?.trim().toLowerCase() === "true") {
  const release = RELEASES[process.arch];
  if (process.platform !== "linux" || release === undefined) {
    throw new Error(
      `Hosted GitHub CLI bootstrap does not support ${process.platform}/${process.arch}`,
    );
  }
  const archiveName = `gh_${VERSION}_linux_${release.architecture}.tar.gz`;
  const archiveUrl = `https://github.com/cli/cli/releases/download/v${VERSION}/${archiveName}`;

  const expectedVersion = `gh version ${VERSION}`;
  if (!installedVersion()?.startsWith(expectedVersion)) {
    const temporaryDirectory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3code-gh-"));
    try {
      const response = await fetch(archiveUrl, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`GitHub CLI download returned ${response.status}`);
      const archive = Buffer.from(await response.arrayBuffer());
      const actualSha256 = NodeCrypto.createHash("sha256").update(archive).digest("hex");
      if (actualSha256 !== release.sha256) {
        throw new Error("GitHub CLI archive checksum did not match the pinned release");
      }

      const archivePath = NodePath.join(temporaryDirectory, archiveName);
      await NodeFSP.writeFile(archivePath, archive);
      NodeChildProcess.execFileSync("tar", ["-xzf", archivePath, "-C", temporaryDirectory], {
        stdio: "inherit",
      });
      const source = NodePath.join(
        temporaryDirectory,
        `gh_${VERSION}_linux_${release.architecture}`,
        "bin",
        "gh",
      );
      await NodeFSP.readFile(source);
      await NodeFSP.mkdir(binDirectory, { recursive: true });
      const stagedTarget = `${target}.new`;
      await NodeFSP.copyFile(source, stagedTarget);
      await NodeFSP.chmod(stagedTarget, 0o755);
      await NodeFSP.rename(stagedTarget, target);
    } finally {
      await NodeFSP.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  console.log(`${installedVersion()} installed at ${target}`);
}
