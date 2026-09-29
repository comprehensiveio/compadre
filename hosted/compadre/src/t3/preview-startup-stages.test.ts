import assert from "node:assert/strict";
import test from "node:test";
import { parsePreviewStartupStages } from "./preview-startup-stages.js";

test("extracts startup durations and failures without forwarding command output", () => {
  assert.deepEqual(parsePreviewStartupStages([
    "database secret output",
    "compadre-dev-stage-v1 bootstrap 0 0",
    "compadre-dev-stage-v1 services 17 0",
    "compadre-dev-stage-v1 launch 1 0",
    "compadre-dev-stage-v1 readiness 154 1",
  ].join("\n")), [
    { stage: "bootstrap", elapsedMs: 0, exitCode: 0 },
    { stage: "services", elapsedMs: 17_000, exitCode: 0 },
    { stage: "launch", elapsedMs: 1_000, exitCode: 0 },
    { stage: "readiness", elapsedMs: 154_000, exitCode: 1 },
  ]);
});

test("legacy output, arbitrary labels and malformed values produce no records", () => {
  assert.deepEqual(parsePreviewStartupStages([
    "DEV_ENV_READY",
    "compadre-dev-stage-v1 secret 4 0",
    "compadre-dev-stage-v1 services -4 0",
    "compadre-dev-stage-v1 services 100000 0",
    "compadre-dev-stage-v1 services 4 256",
    "compadre-dev-stage-v1 services 4 0 secret",
  ].join("\n")), []);
});

test("bounds output to one record per known stage", () => {
  assert.deepEqual(parsePreviewStartupStages("compadre-dev-stage-v1 services 1 0\n".repeat(100)), [
    { stage: "services", elapsedMs: 1_000, exitCode: 0 },
  ]);
});
