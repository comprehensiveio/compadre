/**
 * Proves controller-owned skills stay outside the checkout and can be invoked
 * by both native providers in a freshly provisioned Modal worker.
 *
 * Usage: npx tsx scripts/experiments/native-skill-probe.ts
 */
import assert from "node:assert/strict";
import dotenv from "dotenv";
import { launchManagedT3ModalEnvironment } from "../../src/t3/modal-worker.js";

dotenv.config({ path: ".env.local", quiet: true, override: true });

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const managed = await launchManagedT3ModalEnvironment({
  ...process.env,
  COMPADRE_DEV_ENVIRONMENT_ENABLED: "false",
  COMPADRE_CANONICAL_THREAD_ID: `native-skill-probe-${Date.now()}`,
  COMPADRE_PROVIDER_INSTANCE_ID: "codex",
  COMPADRE_WORKER_GENERATION: "1",
});

try {
  const generatedPaths = [
    ".agents/skills/query-database",
    ".agents/skills/pull-request",
    ".agents/skills/integration-debugging",
    ".agents/skills/dev-environment",
    ".claude/skills/query-database",
    ".claude/skills/pull-request",
    ".claude/skills/integration-debugging",
    ".claude/skills/dev-environment",
  ];
  const pathspec = generatedPaths.map(quote).join(" ");
  const inspection = await managed.handle.process.exec(
    [
      "set -eu",
      "test \"$(readlink /home/node/.codex/skills/query-database)\" = /opt/compadre-skills/query-database",
      "test \"$(readlink /home/node/.claude/skills/query-database)\" = /opt/compadre-skills/query-database",
      `test -z \"$(git status --short --untracked-files=all -- ${pathspec})\"`,
      `test -z \"$(git ls-files --others --exclude-standard -- ${pathspec})\"`,
    ].join(" && "),
  );
  assert.equal(inspection.exitCode, 0, inspection.stderr || inspection.stdout);

  const prompt =
    "Read the query-database skill through the native skill mechanism. Do not query a database. Reply with only the literal value that the skill says identifies a current non-snapshot record.";
  const codexMessages = [
    JSON.stringify({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "compadre-skill-probe", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      },
    }),
    JSON.stringify({ method: "initialized" }),
    JSON.stringify({
      id: 2,
      method: "skills/list",
      params: { cwds: [managed.workspaceRoot] },
    }),
  ];
  const codex = await managed.handle.process.exec(
    `({ printf '%s\\n' ${codexMessages.map(quote).join(" ")}; sleep 2; } | timeout 20 codex app-server) || [ $? -eq 124 ]`,
  );
  assert.equal(codex.exitCode, 0, codex.stderr || codex.stdout);
  assert.ok(
    codex.stdout.includes("query-database"),
    "Codex native skills/list did not discover query-database",
  );
  assert.ok(
    /\/(?:home\/node\/\.codex\/skills|opt\/compadre-skills)\/query-database\/SKILL\.md/.test(
      codex.stdout,
    ),
    "Codex native skills/list did not return the installed query-database skill",
  );
  console.log("[probe] codex: native skills/list discovered query-database");

  const claude = await managed.handle.process.exec(
    `timeout 180 claude -p --model ${quote(process.env.COMPADRE_T3_CLAUDE_MODEL?.trim() || "claude-sonnet-5")} ${quote(`/query-database ${prompt}`)} </dev/null`,
  );
  assert.equal(claude.exitCode, 0, claude.stderr || claude.stdout);
  assert.match(claude.stdout, /NOT_SNAPSHOT/);
  console.log(`[probe] claude: ${claude.stdout.trim().slice(-500)}`);
  console.log(`[probe] SUCCESS sandbox=${managed.sandboxId}`);
} finally {
  await managed.handle.destroy().catch(() => undefined);
  console.log("[probe] sandbox destroyed");
}
