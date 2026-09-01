/**
 * Live validation of launchManagedT3ModalEnvironmentFromTemplate: restore the
 * golden template, refresh the checkout, project skills/fork/credentials,
 * bootstrap T3, and prove the T3 server answers — the exact provision path a
 * production thread would take. The sandbox is destroyed at the end.
 *
 * Usage: npx tsx scripts/experiments/template-launch-probe.ts <im-...>
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

const { launchManagedT3ModalEnvironmentFromTemplate } = await import(
  "../../src/t3/modal-worker.js"
);

const snapshotId = process.argv[2];
if (!snapshotId) throw new Error("usage: template-launch-probe.ts <im-...>");

const environment: NodeJS.ProcessEnv = {
  ...process.env,
  COMPADRE_DEV_ENVIRONMENT_ENABLED: "true",
  COMPADRE_MODAL_CPU: "2",
  COMPADRE_MODAL_CPU_LIMIT: "4",
  COMPADRE_MODAL_MEMORY_MIB: "16384",
  COMPADRE_MODAL_MEMORY_LIMIT_MIB: "32768",
  COMPADRE_MODAL_TIMEOUT_MS: String(60 * 60 * 1000),
  COMPADRE_CANONICAL_THREAD_ID: crypto.randomUUID(),
  COMPADRE_PROVIDER_INSTANCE_ID: "codex",
  COMPADRE_WORKER_GENERATION: "1",
};

const startedAt = Date.now();
const managed = await launchManagedT3ModalEnvironmentFromTemplate(
  snapshotId,
  environment,
);
const launchSeconds = (Date.now() - startedAt) / 1000;
console.log(
  `[probe] launched from template in ${launchSeconds.toFixed(1)}s: sandbox=${managed.sandboxId} project=${managed.projectId}`,
);
try {
  const snapshot = await managed.client.snapshot();
  console.log(
    `[probe] T3 alive: projects=${snapshot.projects.length} threads=${snapshot.threads.length}`,
  );
  const handle = managed.handle as unknown as {
    process: {
      exec(command: string): Promise<{ exitCode: number; stdout: string }>;
    };
  };
  const head = await handle.process.exec("git log -1 --format='%H %cI %s'");
  console.log(`[probe] checkout head: ${head.stdout.trim()}`);
  const data = await handle.process.exec("scripts/compadre-dev-data.sh status");
  console.log(`[probe] data mode:\n${data.stdout}`);
  const skills = await handle.process.exec(
    "ls /workspace/.agents/skills 2>/dev/null || true",
  );
  console.log(`[probe] skills: ${skills.stdout.trim().split("\n").join(", ")}`);
  console.log(
    `[probe] SUCCESS total=${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
} finally {
  await managed.handle.destroy().catch(() => undefined);
  console.log("[probe] sandbox destroyed");
}
process.exit(0);
