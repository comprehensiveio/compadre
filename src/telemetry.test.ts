import assert from "node:assert/strict";
import test from "node:test";
import { datadogOtlpTracesEndpoint } from "./telemetry.js";

test("derives the agentless OTLP endpoint from the Datadog site", () => {
  assert.equal(
    datadogOtlpTracesEndpoint({ DD_SITE: "datadoghq.com" }),
    "https://otlp.datadoghq.com/v1/traces",
  );
  assert.equal(
    datadogOtlpTracesEndpoint({ DD_SITE: "us3.datadoghq.com" }),
    "https://otlp.us3.datadoghq.com/v1/traces",
  );
});

test("allows an explicit OTLP traces endpoint", () => {
  assert.equal(
    datadogOtlpTracesEndpoint({
      DD_OTLP_TRACES_ENDPOINT: "https://telemetry.example/v1/traces",
    }),
    "https://telemetry.example/v1/traces",
  );
});
