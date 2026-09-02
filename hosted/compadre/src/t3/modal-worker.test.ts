import assert from "node:assert/strict";
import test from "node:test";
import {
  blockedSlackDestinationFromEnvironment,
  nativeHarnessAuthenticationCommand,
  parseT3StartupToken,
  parseT3SlackDestinationMarker,
  projectedProviderEnvironment,
  t3ServerLaunchCommands,
} from "./modal-worker.js";
import { scopedEnvironmentBridgeToken } from "../tanstack/relay-tool-bridge.js";

test("extracts T3's one-time startup token without accepting lookalikes", () => {
  assert.equal(
    parseT3StartupToken(
      "Listening at http://0.0.0.0:3773\nToken: 23456789ABCD\nPairing URL: http://localhost/pair\n",
    ),
    "23456789ABCD",
  );
  assert.equal(parseT3StartupToken("Token: ABCDEFGHIJKL"), undefined);
  assert.equal(parseT3StartupToken("Token: 23456789ABCDextra"), undefined);
});

test("records only a complete protected Slack destination", () => {
  assert.deepEqual(
    blockedSlackDestinationFromEnvironment({
      COMPADRE_BLOCKED_SLACK_CHANNEL_ID: " C1 ",
      COMPADRE_BLOCKED_SLACK_THREAD_TS: " 1.0 ",
    }),
    { channelId: "C1", threadTs: "1.0" },
  );
  assert.equal(
    blockedSlackDestinationFromEnvironment({
      COMPADRE_BLOCKED_SLACK_CHANNEL_ID: "C1",
    }),
    undefined,
  );
  assert.deepEqual(
    parseT3SlackDestinationMarker(
      JSON.stringify({ channelId: "C1", threadTs: "1.0" }),
    ),
    { channelId: "C1", threadTs: "1.0" },
  );
  assert.equal(parseT3SlackDestinationMarker("invalid"), undefined);
});

test("repairs Codex config ownership before authenticating a restored worker", () => {
  const command = nativeHarnessAuthenticationCommand();
  const ownershipRepair = command.indexOf(
    "chown -R node:node /home/node/.codex",
  );
  const login = command.indexOf("codex login --with-api-key");

  assert.ok(ownershipRepair >= 0);
  assert.ok(login > ownershipRepair);
  assert.match(command, /install -d -m 700 -o node -g node/);
});

test("cleans stale T3 launch artifacts before starting and recording the new pid", () => {
  const commands = t3ServerLaunchCommands("/workspace");

  assert.match(commands.cleanup, /^rm -f /);
  assert.doesNotMatch(commands.cleanup, /nohup|&/);
  assert.match(commands.launch, /^nohup /);
  assert.doesNotMatch(commands.launch, /rm -f/);
  assert.match(commands.launch, /& echo \$! > \/var\/run\/t3\.pid$/);
});

test("projects one Compadre MCP bridge into T3's native provider environment", () => {
  assert.deepEqual(
    projectedProviderEnvironment({
      COMPADRE_PUBLIC_URL: "https://compadre-experiment.example/base",
      COMPADRE_T3_MCP_BEARER_TOKEN: "bridge-token",
    }),
    {
      COMPADRE_MCP_URL: "https://compadre-experiment.example/internal/t3-mcp",
      COMPADRE_MCP_BEARER_TOKEN: "bridge-token",
    },
  );
  assert.throws(
    () =>
      projectedProviderEnvironment({
        COMPADRE_T3_MCP_BEARER_TOKEN: "bridge-token",
      }),
    /must be configured together/,
  );
  assert.deepEqual(
    projectedProviderEnvironment({
      COMPADRE_PUBLIC_URL: "https://compadre.example",
      COMPADRE_T3_MCP_BEARER_TOKEN: "bridge-token",
      COMPADRE_BLOCKED_SLACK_CHANNEL_ID: "C123",
      COMPADRE_BLOCKED_SLACK_THREAD_TS: "123.456",
    }),
    {
      COMPADRE_MCP_URL:
        "https://compadre.example/internal/t3-mcp?slack_channel_id=C123&slack_thread_ts=123.456",
      COMPADRE_MCP_BEARER_TOKEN: scopedEnvironmentBridgeToken("bridge-token", {
        channelId: "C123",
        threadTs: "123.456",
      }),
    },
  );
  assert.deepEqual(
    projectedProviderEnvironment({
      COMPADRE_PUBLIC_URL: "https://compadre-experiment.example",
      COMPADRE_API_KEY: "experiment-api-key",
    }),
    {
      COMPADRE_MCP_URL: "https://compadre-experiment.example/internal/t3-mcp",
      COMPADRE_MCP_BEARER_TOKEN: "experiment-api-key",
    },
  );
});

test("projects direct Datadog OTLP telemetry into the isolated T3 worker", () => {
  assert.deepEqual(
    projectedProviderEnvironment({
      DD_API_KEY: "dd-secret",
      DD_SITE: "datadoghq.eu",
      DD_ENV: "experiment",
      DD_LLMOBS_ML_APP: "compadre",
      COMPADRE_CANONICAL_THREAD_ID: "slack:C01:123.456",
      COMPADRE_PROVIDER_INSTANCE_ID: "codex",
    }),
    {
      DD_API_KEY: "dd-secret",
      DD_SITE: "datadoghq.eu",
      DD_ENV: "experiment",
      DD_LLMOBS_ML_APP: "compadre",
      COMPADRE_CANONICAL_THREAD_ID: "slack:C01:123.456",
      COMPADRE_PROVIDER_INSTANCE_ID: "codex",
      T3CODE_OTLP_TRACES_URL: "https://otlp.datadoghq.eu/v1/traces",
      T3CODE_OTLP_SERVICE_NAME: "compadre-worker",
      T3CODE_DD_LLMOBS_EXPORT_ENABLED: "false",
    },
  );
});

test("preserves an explicitly configured OTLP collector", () => {
  assert.deepEqual(
    projectedProviderEnvironment({
      T3CODE_OTLP_TRACES_URL: "https://collector.example/v1/traces",
      T3CODE_OTLP_SERVICE_NAME: "custom-worker",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "authorization=secret",
    }),
    {
      T3CODE_OTLP_TRACES_URL: "https://collector.example/v1/traces",
      T3CODE_OTLP_SERVICE_NAME: "custom-worker",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "authorization=secret",
    },
  );
});
