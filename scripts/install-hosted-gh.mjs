import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binDirectory = join(repositoryRoot, ".compadre", "bin");
const target = join(binDirectory, "gh");

function installedVersion() {
  try {
    return execFileSync(target, ["--version"], { encoding: "utf8" }).split("\n", 1)[0]?.trim();
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
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "t3code-gh-"));
    try {
      const response = await fetch(archiveUrl, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`GitHub CLI download returned ${response.status}`);
      const archive = Buffer.from(await response.arrayBuffer());
      const actualSha256 = createHash("sha256").update(archive).digest("hex");
      if (actualSha256 !== release.sha256) {
        throw new Error("GitHub CLI archive checksum did not match the pinned release");
      }

      const archivePath = join(temporaryDirectory, archiveName);
      await writeFile(archivePath, archive);
      execFileSync("tar", ["-xzf", archivePath, "-C", temporaryDirectory], { stdio: "inherit" });
      const source = join(
        temporaryDirectory,
        `gh_${VERSION}_linux_${release.architecture}`,
        "bin",
        "gh",
      );
      await readFile(source);
      await mkdir(binDirectory, { recursive: true });
      const stagedTarget = `${target}.new`;
      await copyFile(source, stagedTarget);
      await chmod(stagedTarget, 0o755);
      await rename(stagedTarget, target);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  console.log(`${installedVersion()} installed at ${target}`);
}
