/**
 * Cold-start experiment probe: measures each phase of bringing a Compadre
 * worker sandbox from nothing to a usable dev environment, and tests the
 * "golden template snapshot" hypothesis (restore a pre-warmed filesystem
 * instead of cold-building one).
 *
 * Runs entirely from a laptop against real Modal. Never touches production
 * threads; every sandbox it creates is terminated in a finally block unless
 * --keep is passed.
 *
 * Usage:
 *   npx tsx scripts/experiments/cold-start-probe.ts baseline [--snapshot] [--keep]
 *   npx tsx scripts/experiments/cold-start-probe.ts restore --snapshot-id <im-...> [--keep]
 *
 * Requires in .env.local: MODAL_TOKEN_ID/SECRET, GITHUB_PERSONAL_ACCESS_TOKEN.
 * Requires in the environment (do not persist): COMPADRE_DEV_BACKUP_ACCESS_SECRET
 * (the production secret, to mint a scoped manifest token for the real
 * hourly backup download).
 */
import crypto from "node:crypto";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

const { modalSandboxProvider } = await import("../../src/tanstack/modal-sandbox.js");
const { issueDevBackupAccessToken } = await import("../../src/t3/dev-backups.js");
const { devEnvironmentArtifactProjection } = await import("../../src/t3/dev-environment.js");

const PROBE_ENVIRONMENT: NodeJS.ProcessEnv = {
  ...process.env,
  COMPADRE_MODAL_APP: process.env.COMPADRE_T3_MODAL_APP?.trim() || "compadre",
  COMPADRE_DEV_ENVIRONMENT_ENABLED: "true",
  COMPADRE_MODAL_CPU: "2",
  COMPADRE_MODAL_CPU_LIMIT: "4",
  COMPADRE_MODAL_MEMORY_MIB: "16384",
  COMPADRE_MODAL_MEMORY_LIMIT_MIB: "32768",
  // Probe sandboxes self-destruct after 3h even if this process dies.
  COMPADRE_MODAL_TIMEOUT_MS: String(3 * 60 * 60 * 1000),
  COMPADRE_MODAL_SNAPSHOT_TTL_MS: String(7 * 24 * 60 * 60 * 1000),
};

const timings: Array<{ phase: string; seconds: number; note?: string }> = [];

async function timed<T>(
  phase: string,
  task: () => Promise<T>,
  note?: string,
): Promise<T> {
  const startedAt = Date.now();
  process.stdout.write(`[probe] ${phase}...\n`);
  try {
    return await task();
  } finally {
    const seconds = (Date.now() - startedAt) / 1000;
    timings.push({ phase, seconds, ...(note ? { note } : {}) });
    process.stdout.write(`[probe] ${phase} took ${seconds.toFixed(1)}s\n`);
  }
}

interface ExecHandle {
  id: string;
  process: {
    exec(
      command: string,
      options?: { env?: Record<string, string>; cwd?: string },
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
  env: { set(vars: Record<string, string>): Promise<void> };
  ports: { connect(port: number): Promise<{ url: string }> };
  checkpoint(label?: string): Promise<{ id: string }>;
  destroy(): Promise<void>;
}

/** Mirror production's dev environment projections (artifacts + preview). */
async function projectDevEnvironment(handle: ExecHandle): Promise<void> {
  const preview = await handle.ports.connect(3000);
  const artifacts = await devEnvironmentArtifactProjection(PROBE_ENVIRONMENT);
  process.stdout.write(
    `[probe] artifact urls projected: ${Object.keys(artifacts).join(", ") || "none"}\n`,
  );
  await handle.env.set({
    ...artifacts,
    COMPADRE_DEV_PREVIEW_URL: preview.url.replace(/\/$/, ""),
    COMPADRE_DEV_PORT: "3000",
    AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
  });
}

async function run(
  handle: ExecHandle,
  command: string,
  options?: { env?: Record<string, string>; allowFailure?: boolean },
): Promise<string> {
  const result = await handle.process.exec(command, options);
  if (result.exitCode !== 0 && !options?.allowFailure) {
    throw new Error(
      `command failed (${result.exitCode}): ${command}\n--- stdout tail ---\n${result.stdout.slice(-3000)}\n--- stderr tail ---\n${result.stderr.slice(-3000)}`,
    );
  }
  return result.stdout;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function backupAccessEnvironment(): Record<string, string> {
  const secret = process.env.COMPADRE_DEV_BACKUP_ACCESS_SECRET?.trim();
  if (!secret) {
    throw new Error(
      "COMPADRE_DEV_BACKUP_ACCESS_SECRET is required to test the real DB download",
    );
  }
  const threadId = crypto.randomUUID();
  return {
    COMPADRE_DEV_BACKUP_MANIFEST_URL: `https://compadre-api.comprehensive.io/internal/dev-backups/${threadId}/latest`,
    COMPADRE_DEV_BACKUP_TOKEN: issueDevBackupAccessToken({
      canonicalThreadId: threadId,
      secret,
      expiresAtSeconds: Math.floor(Date.now() / 1000) + 3 * 60 * 60,
    }),
  };
}

function cloneCommand(): string {
  const repositoryUrl =
    process.env.GITHUB_REPO_URL?.trim() ||
    "https://github.com/comprehensiveio/comp.git";
  const branch = process.env.REPO_BRANCH?.trim() || "main";
  return `git -c credential.helper='!f() { echo "username=$GIT_ASKPASS_USER"; echo "password=$GIT_ASKPASS_TOKEN"; }; f' clone --depth 1 --single-branch --branch ${quote(branch)} -- ${quote(repositoryUrl)} . 2>&1`;
}

async function measureDiskUsage(handle: ExecHandle): Promise<void> {
  const usage = await run(
    handle,
    "du -sh /workspace /workspace/node_modules /var/lib/postgresql 2>/dev/null || true",
    { allowFailure: true },
  );
  process.stdout.write(`[probe] disk usage:\n${usage}`);
}

async function measureFirstPage(handle: ExecHandle, label: string): Promise<void> {
  await timed(`${label}: first page (wait for socket + vite compile)`, () =>
    run(
      handle,
      `for i in $(seq 1 240); do code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 600 http://127.0.0.1:3000/login 2>/dev/null); if [ -n "$code" ] && [ "$code" != 000 ]; then echo "http=$code after $i attempts"; exit 0; fi; sleep 2; done; echo 'never became reachable'; ss -ltn || netstat -ltn || true; scripts/compadre-dev-up.sh status || true; tail -40 /var/tmp/compadre-dev*.log 2>/dev/null || true`,
      { allowFailure: true },
    ).then((out) => process.stdout.write(`[probe] ${out}\n`)),
  );
  await timed(`${label}: second page (warm)`, () =>
    run(
      handle,
      "curl -s -o /dev/null -w 'http=%{http_code} time=%{time_total}s' --max-time 120 http://127.0.0.1:3000/login; echo",
      { allowFailure: true },
    ).then((out) => process.stdout.write(`[probe] ${out}\n`)),
  );
}

function report(): void {
  process.stdout.write("\n=== PHASE TIMINGS ===\n");
  let total = 0;
  for (const t of timings) {
    total += t.seconds;
    process.stdout.write(
      `${t.phase.padEnd(45)} ${(t.seconds / 60).toFixed(1).padStart(6)} min${t.note ? `  (${t.note})` : ""}\n`,
    );
  }
  process.stdout.write(`${"TOTAL".padEnd(45)} ${(total / 60).toFixed(1).padStart(6)} min\n`);
  process.stdout.write(`\nJSON: ${JSON.stringify(timings)}\n`);
}

async function baseline(options: { snapshot: boolean; keep: boolean }) {
  const provider = modalSandboxProvider({
    environment: PROBE_ENVIRONMENT,
    encryptedPorts: [3000],
  });
  const handle = (await timed("sandbox.create (incl image resolve)", () =>
    provider.create({ id: `coldstart-probe-${Date.now()}` }),
  )) as unknown as ExecHandle;
  process.stdout.write(`[probe] sandbox: ${handle.id}\n`);
  try {
    await handle.env.set({
      GIT_ASKPASS_USER: "x-access-token",
      GIT_ASKPASS_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN ?? "",
      ...backupAccessEnvironment(),
      HOME: "/home/node",
    });
    await projectDevEnvironment(handle);

    await timed("repository.clone (depth 1)", () => run(handle, cloneCommand()));
    await timed("dev-up (deps + services + vite)", () =>
      run(handle, "set -o pipefail; scripts/compadre-dev-up.sh up 2>&1 | tail -15").then(
        (out) => process.stdout.write(out),
      ),
    );
    await measureFirstPage(handle, "cold");
    await timed("dev-data production-latest (download+restore)", () =>
      run(
        handle,
        "set -o pipefail; scripts/compadre-dev-data.sh production-latest 2>&1 | tail -8",
      ).then((out) => process.stdout.write(out)),
    );
    await measureDiskUsage(handle);

    if (options.snapshot) {
      const checkpoint = await timed("golden snapshot capture (live)", () =>
        handle.checkpoint("coldstart-golden"),
      );
      process.stdout.write(`\n[probe] GOLDEN SNAPSHOT ID: ${checkpoint.id}\n`);
    }
  } finally {
    report();
    if (!options.keep) {
      await handle.destroy().catch(() => undefined);
      process.stdout.write("[probe] sandbox terminated\n");
    } else {
      process.stdout.write(`[probe] sandbox kept alive: ${handle.id}\n`);
    }
  }
}

async function restore(options: { snapshotId: string; keep: boolean }) {
  const provider = modalSandboxProvider({
    environment: PROBE_ENVIRONMENT,
    encryptedPorts: [3000],
  });
  if (!provider.restoreSnapshot) throw new Error("provider lacks restoreSnapshot");
  const handle = (await timed("restore sandbox from golden snapshot", () =>
    provider.restoreSnapshot!({ snapshotId: options.snapshotId }),
  )) as unknown as ExecHandle;
  process.stdout.write(`[probe] restored sandbox: ${handle.id}\n`);
  try {
    await handle.env.set({ HOME: "/home/node" });
    await projectDevEnvironment(handle);
    await timed("dev-data status (is the DB still there?)", () =>
      run(handle, "scripts/compadre-dev-data.sh status", { allowFailure: true }).then(
        (out) => process.stdout.write(out),
      ),
    );
    await timed("dev-up (restart services on warm fs)", () =>
      run(handle, "set -o pipefail; scripts/compadre-dev-up.sh up 2>&1 | tail -15").then(
        (out) => process.stdout.write(out),
      ),
    );
    await measureFirstPage(handle, "restored");
    // Prove the restored DB is the production-derived one (company 9 exists).
    await timed("verify restored DB content", () =>
      run(
        handle,
        `psql "$(bin/lib/hen_get_remote_db_url -e local)" -qAt -c 'SELECT count(*) FROM companies' && scripts/compadre-dev-data.sh status`,
        { allowFailure: true },
      ).then((out) => process.stdout.write(`[probe] db check:\n${out}\n`)),
    );
    // A restored worker also needs a fresh-enough repo: measure the update
    // path that a template-based provision would run instead of a clone.
    await timed("git fetch + reset (template refresh path)", () =>
      run(
        handle,
        "git fetch --depth 1 origin main 2>&1 | tail -2 && git reset --hard origin/main 2>&1 | tail -2",
      ).then((out) => process.stdout.write(out)),
    );
  } finally {
    report();
    if (!options.keep) {
      await handle.destroy().catch(() => undefined);
      process.stdout.write("[probe] sandbox terminated\n");
    } else {
      process.stdout.write(`[probe] sandbox kept alive: ${handle.id}\n`);
    }
  }
}

const mode = process.argv[2];
const keep = process.argv.includes("--keep");
if (mode === "baseline") {
  await baseline({ snapshot: process.argv.includes("--snapshot"), keep });
} else if (mode === "restore") {
  const index = process.argv.indexOf("--snapshot-id");
  const snapshotId = index >= 0 ? process.argv[index + 1] : undefined;
  if (!snapshotId) throw new Error("restore requires --snapshot-id <im-...>");
  await restore({ snapshotId, keep });
} else {
  throw new Error("usage: cold-start-probe.ts baseline [--snapshot] [--keep] | restore --snapshot-id <id> [--keep]");
}
process.exit(0);
