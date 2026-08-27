import { describe, expect, it } from "@effect/vitest";

import { otlpTraceHeaders } from "./Observability.ts";

describe("otlpTraceHeaders", () => {
  it("adds Datadog direct-intake and LLM Observability headers", () => {
    expect(
      otlpTraceHeaders("https://otlp.datadoghq.com/v1/traces", {
        DD_API_KEY: "dd-secret",
        DD_LLMOBS_ML_APP: "compadre-experiment",
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x-tenant=alpha%20team",
      }),
    ).toEqual({
      "x-tenant": "alpha team",
      "dd-api-key": "dd-secret",
      "dd-ml-app": "compadre-experiment",
      "dd-otlp-source": "llmobs",
      compute_stats: "true",
    });
  });

  it("does not leak the Datadog key to non-Datadog collectors", () => {
    expect(
      otlpTraceHeaders("https://otel-collector.example/v1/traces", {
        DD_API_KEY: "dd-secret",
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: "authorization=Bearer%20collector",
      }),
    ).toEqual({ authorization: "Bearer collector" });
  });
});
