import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  configureEphemeralRepositoryEnvironment,
  configureTelemetryEnvironment,
  usesAgentlessWorkflowTelemetry,
} from "./process-bootstrap.js";

test("configures Workflow processes for immediate trace export", () => {
  const environment: NodeJS.ProcessEnv = {};

  configureTelemetryEnvironment({ ephemeral: true }, environment);

  assert.equal(environment.DD_TRACE_FLUSH_INTERVAL, "0");
  assert.equal(environment.DD_TRACE_OTEL_ENABLED, "true");
  assert.equal(environment.DD_LLMOBS_ENABLED, "1");
});

test("does not change persistent process batching or deployment overrides", () => {
  const persistentEnvironment: NodeJS.ProcessEnv = {};
  configureTelemetryEnvironment({}, persistentEnvironment);
  assert.equal(persistentEnvironment.DD_TRACE_FLUSH_INTERVAL, undefined);

  const overriddenEnvironment: NodeJS.ProcessEnv = {
    DD_TRACE_FLUSH_INTERVAL: "500",
  };
  configureTelemetryEnvironment({ ephemeral: true }, overriddenEnvironment);
  assert.equal(overriddenEnvironment.DD_TRACE_FLUSH_INTERVAL, "500");
});

test("uses exactly one direct telemetry provider in ephemeral Workflows", () => {
  assert.equal(
    usesAgentlessWorkflowTelemetry(
      { ephemeral: true },
      { DD_API_KEY: "test-key" },
    ),
    true,
  );
  assert.equal(
    usesAgentlessWorkflowTelemetry({}, { DD_API_KEY: "test-key" }),
    false,
  );
  assert.equal(usesAgentlessWorkflowTelemetry({ ephemeral: true }, {}), false);
});

test("uses a baked checkout only for an ephemeral process", async () => {
  const processRoot = await mkdtemp(
    path.join(tmpdir(), "compadre-baked-repository-"),
  );
  const repositoryPath = path.join(
    processRoot,
    ".workflow-cache",
    "repository",
  );
  await mkdir(path.join(repositoryPath, ".git"), { recursive: true });

  try {
    const environment: NodeJS.ProcessEnv = {
      REPO_PATH: "/opt/render/repo",
    };
    configureEphemeralRepositoryEnvironment(
      { ephemeral: true },
      environment,
      processRoot,
    );
    assert.equal(environment.REPO_PATH, repositoryPath);
    assert.equal(environment.COMPADRE_SINGLE_USE_REPOSITORY, "true");

    const overriddenEnvironment: NodeJS.ProcessEnv = {
      COMPADRE_WORKFLOW_REPO_PATH: "/custom/workflow/repository",
    };
    configureEphemeralRepositoryEnvironment(
      { ephemeral: true },
      overriddenEnvironment,
      processRoot,
    );
    assert.equal(
      overriddenEnvironment.REPO_PATH,
      "/custom/workflow/repository",
    );

    const persistentEnvironment: NodeJS.ProcessEnv = {};
    configureEphemeralRepositoryEnvironment(
      {},
      persistentEnvironment,
      processRoot,
    );
    assert.equal(persistentEnvironment.REPO_PATH, undefined);
  } finally {
    await rm(processRoot, { recursive: true, force: true });
  }
});

test("warns when an ephemeral image has no baked checkout", async (t) => {
  const processRoot = await mkdtemp(
    path.join(tmpdir(), "compadre-missing-repository-"),
  );
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => void warnings.push(args));

  try {
    const environment: NodeJS.ProcessEnv = {};
    configureEphemeralRepositoryEnvironment(
      { ephemeral: true },
      environment,
      processRoot,
    );
    assert.equal(environment.REPO_PATH, undefined);
    assert.match(String(warnings[0]?.[0]), /baked checkout is missing/);
  } finally {
    await rm(processRoot, { recursive: true, force: true });
  }
});
