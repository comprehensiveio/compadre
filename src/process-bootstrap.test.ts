import assert from "node:assert/strict";
import test from "node:test";
import { configureTelemetryEnvironment } from "./process-bootstrap.js";

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
