import assert from "node:assert/strict";
import test from "node:test";
import {
  datadogOtlpTracesEndpoint,
  datadogTelemetryMode,
} from "./telemetry.js";

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
  assert.equal(
    datadogOtlpTracesEndpoint({
      DD_OTLP_TRACES_ENDPOINT: "https://legacy.example/v1/traces",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:
        "https://standard.example/v1/traces",
    }),
    "https://standard.example/v1/traces",
  );
});

test("allows persistent managed services to select direct OTLP export", () => {
  assert.equal(
    datadogTelemetryMode({
      environment: {
        COMPADRE_OTEL_EXPORT_MODE: "agentless",
        DD_API_KEY: "test-key",
      },
    }),
    "agentless",
  );
  assert.equal(
    datadogTelemetryMode({
      environment: { COMPADRE_OTEL_EXPORT_MODE: "agentless" },
    }),
    "agent",
  );
});
