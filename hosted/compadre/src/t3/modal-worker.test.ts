import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  blockedSlackDestinationFromEnvironment,
  codexAuthJsonFromEnvironment,
  configureNativeHarnessAuthentication,
  nativeHarnessAuthenticationCommand,
  nativeHarnessAuthenticationPreparationCommand,
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
  const preparation = nativeHarnessAuthenticationPreparationCommand();
  const command = nativeHarnessAuthenticationCommand();
  const ownershipRepair = preparation.indexOf(
    "chown -R node:node /home/node/.codex",
  );
  const login = command.indexOf("codex login --with-api-key");

  assert.ok(ownershipRepair >= 0);
  assert.ok(login >= 0);
  assert.match(preparation, /install -d -m 700 -o node -g node/);
});

test("projects Render-owned ChatGPT auth as a protected file without exposing it in commands", async () => {
  const authJson = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { refresh_token: "refresh-secret" },
  });
  const commands: string[] = [];
  const writes: Array<{ path: string; contents: string }> = [];
  await configureNativeHarnessAuthentication(
    {
      id: "sandbox",
      process: {
        exec: async (command) => {
          commands.push(Array.isArray(command) ? command.join(" ") : command);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      fs: {
        read: async () => "",
        write: async (path, contents) => {
          writes.push({ path, contents });
        },
      },
      env: { set: async () => undefined },
      ports: { connect: async () => ({ url: "https://example.test" }) },
      destroy: async () => undefined,
    },
    { CODEX_AUTH_JSON_BASE64: Buffer.from(authJson).toString("base64") },
  );

  assert.deepEqual(writes, [
    { path: "/home/node/.codex/auth.json", contents: authJson },
    {
      path: "/home/node/.codex/compadre-auth-seed.sha256",
      contents: createHash("sha256").update(authJson).digest("hex"),
    },
  ]);
  assert.equal(
    commands.some((command) => command.includes(authJson)),
    false,
  );
  assert.equal(
    commands.some((command) => command.includes("refresh-secret")),
    false,
  );
  assert.equal(
    commands.some((command) => command.includes("CODEX_AUTH_JSON_BASE64")),
    false,
  );
  assert.match(commands.at(-1) ?? "", /chmod 600/);
});

test("preserves refreshed Codex auth when the Render seed has not rotated", async () => {
  const authJson = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { refresh_token: "seed-refresh-token" },
  });
  const seedDigest = createHash("sha256").update(authJson).digest("hex");
  const writes: Array<{ path: string; contents: string }> = [];
  await configureNativeHarnessAuthentication(
    {
      id: "restored-sandbox",
      process: {
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      },
      fs: {
        read: async (path) =>
          path.endsWith(".sha256")
            ? seedDigest
            : JSON.stringify({
                auth_mode: "chatgpt",
                tokens: { refresh_token: "newer-refreshed-token" },
              }),
        write: async (path, contents) => {
          writes.push({ path, contents });
        },
      },
      env: { set: async () => undefined },
      ports: { connect: async () => ({ url: "https://example.test" }) },
      destroy: async () => undefined,
    },
    { CODEX_AUTH_JSON_BASE64: Buffer.from(authJson).toString("base64") },
  );

  assert.deepEqual(writes, []);
});

test("keeps the named Modal secret as a rollout fallback", () => {
  const command = nativeHarnessAuthenticationCommand();

  assert.match(command, /CODEX_AUTH_JSON_BASE64/);
  assert.ok(
    command.indexOf("CODEX_AUTH_JSON_BASE64") <
      command.indexOf("OPENAI_API_KEY"),
  );
});

test("explicitly disabled subscription experiment initializes API-only auth", async () => {
  const commands: string[] = [];
  const writes: Array<{ path: string; contents: string }> = [];
  await configureNativeHarnessAuthentication(
    {
      id: "sandbox",
      process: {
        exec: async (command) => {
          commands.push(Array.isArray(command) ? command.join(" ") : command);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      fs: {
        read: async () => "",
        write: async (path, contents) => {
          writes.push({ path, contents });
        },
      },
      env: { set: async () => undefined },
      ports: { connect: async () => ({ url: "https://example.test" }) },
      destroy: async () => undefined,
    },
    {
      COMPADRE_CODEX_SUBSCRIPTION_EXPERIMENT_ENABLED: "false",
      CODEX_AUTH_JSON_BASE64:
        Buffer.from("should-not-be-used").toString("base64"),
      OPENAI_API_KEY: "api-secret",
    },
  );

  assert.match(commands.join("\n"), /codex login --with-api-key/);
  assert.equal(commands.join("\n").includes("api-secret"), false);
  assert.deepEqual(writes.at(-1), {
    path: "/home/node/.codex/compadre-auth-route",
    contents: "api",
  });
});

test("rejects malformed or non-ChatGPT Codex auth before projection", () => {
  assert.throws(
    () => codexAuthJsonFromEnvironment({ CODEX_AUTH_JSON_BASE64: "%%%" }),
    /valid base64/,
  );
  assert.throws(
    () =>
      codexAuthJsonFromEnvironment({
        CODEX_AUTH_JSON_BASE64: Buffer.from(
          JSON.stringify({ auth_mode: "apikey" }),
        ).toString("base64"),
      }),
    /ChatGPT-managed/,
  );
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
