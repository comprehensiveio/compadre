import assert from "node:assert/strict";
import test from "node:test";
import type { MetadataStore } from "./storage.js";
import {
  clearWorkerTemplate,
  publishWorkerTemplate,
  prepareT3WorkerTemplate,
  readWorkerTemplate,
  workerTemplateIsFresh,
  WORKER_TEMPLATE_MAX_AGE_MS,
} from "./worker-templates.js";

test("template preparation migrates the local seed before checking app readiness", async () => {
  const commands: string[] = [];
  await prepareT3WorkerTemplate({
    id: "builder-test",
    process: {
      async exec(command) {
        commands.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  });
  assert.equal(commands.length, 3);
  assert.match(commands[0]!, /cloud-env-setup\.sh/);
  assert.match(
    commands[1]!,
    /DATABASE_URL="\$\(bin\/lib\/hen_get_remote_db_url -e local\)"/,
  );
  assert.match(commands[1]!, /migrate:cm:deploy/);
  assert.match(commands[2]!, /compadre-dev-up\.sh up/);
});

for (const failingStep of [0, 1]) {
  test(`template preparation stops on ${failingStep === 0 ? "bootstrap" : "migration"} failure`, async () => {
    const commands: string[] = [];
    await assert.rejects(
      prepareT3WorkerTemplate({
        id: "builder-test",
        process: {
          async exec(command) {
            commands.push(command);
            return {
              exitCode: commands.length - 1 === failingStep ? 1 : 0,
              stdout: "",
              stderr: "preparation failed",
            };
          },
        },
      }),
      /preparation failed/,
    );
    assert.equal(commands.length, failingStep + 1);
    assert.equal(
      commands.some((command) => command.includes("compadre-dev-up.sh up")),
      false,
    );
  });
}

function memoryMetadata(): MetadataStore {
  const data = new Map<string, unknown>();
  return {
    async get(namespace, key) {
      const value = data.get(`${namespace}:${key}`);
      return value === undefined ? null : value;
    },
    async set(namespace, key, value) {
      data.set(`${namespace}:${key}`, JSON.parse(JSON.stringify(value)));
    },
    async delete(namespace, key) {
      data.delete(`${namespace}:${key}`);
    },
  };
}

test("round-trips, validates, and clears the worker template pointer", async () => {
  const metadata = memoryMetadata();
  assert.equal(await readWorkerTemplate(metadata), null);

  const template = {
    snapshotId: "im-template-1",
    repoSha: "abc123",
    backupKey: "hourly/db-backup.sql.gz",
    builtAt: "2026-09-01T00:00:00.000Z",
  };
  await publishWorkerTemplate(metadata, template);
  assert.deepEqual(await readWorkerTemplate(metadata), template);

  await clearWorkerTemplate(metadata);
  assert.equal(await readWorkerTemplate(metadata), null);
});

test("a malformed pointer reads as no template (cold build)", async () => {
  const metadata = memoryMetadata();
  await metadata.set("compadre.t3.worker-template.v1", "current", {
    snapshotId: "   ",
  });
  assert.equal(await readWorkerTemplate(metadata), null);
});

test("template cache expires after one day without deleting its diagnostic pointer", async () => {
  const metadata = memoryMetadata();
  const template = {
    snapshotId: "im-old",
    repoSha: "sha",
    backupKey: "backup",
    builtAt: "2026-09-01T00:00:00Z",
  };
  await publishWorkerTemplate(metadata, template);
  const built = Date.parse(template.builtAt);
  assert.equal(
    workerTemplateIsFresh(template, built + WORKER_TEMPLATE_MAX_AGE_MS - 1),
    true,
  );
  assert.equal(
    workerTemplateIsFresh(template, built + WORKER_TEMPLATE_MAX_AGE_MS),
    false,
  );
  assert.equal(workerTemplateIsFresh(template, built - 1), false);
  assert.deepEqual(await readWorkerTemplate(metadata), template);
});
