import assert from "node:assert/strict";
import test from "node:test";
import {
  appendTelemetryContent,
  createTelemetryContentRedactor,
  serializeTelemetryValue,
} from "./telemetry-content.js";

test("redacts configured secrets and bounds captured content", () => {
  const redact = createTelemetryContentRedactor(
    {
      API_TOKEN: "long-secret-value",
      DATABASE_URL: 'postgres://user:abc"defgh@host/db',
      ORDINARY_SETTING: "visible-value",
    },
    32,
  );

  const result = redact(
    "token=long-secret-value setting=visible-value and trailing content",
  );

  assert.equal(result, "token=[REDACTED] setting=visibl…");
  assert.equal(result.includes("long-secret-value"), false);
  assert.equal(
    redact(serializeTelemetryValue({ url: 'postgres://user:abc"defgh@host/db' })),
    '{"url":"[REDACTED]"}',
  );
});

test("bounds streamed tool content during accumulation", () => {
  const first = appendTelemetryContent(undefined, "12345", 8);
  const second = appendTelemetryContent(first, "67890", 8);
  const ignored = appendTelemetryContent(second, "more", 8);

  assert.equal(first, "12345");
  assert.equal(second, "1234567…");
  assert.equal(ignored, second);
});

test("serializes unusual tool values without throwing", () => {
  const circular: { self?: unknown } = {};
  circular.self = circular;

  assert.equal(serializeTelemetryValue(circular), "[unserializable]");
  assert.equal(serializeTelemetryValue({ ok: true }), '{"ok":true}');
});
