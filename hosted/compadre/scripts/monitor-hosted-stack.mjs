#!/usr/bin/env node

import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULTS = Object.freeze({
  webUrl: "https://compadre.comprehensive.io/",
  webOriginUrl: "https://t3code-compadre-experiment.onrender.com/",
  descriptorUrl:
    "https://compadre.comprehensive.io/.well-known/t3/environment",
  controllerHealthUrl: "https://compadre-api.comprehensive.io/health",
  attempts: 3,
  retryDelayMs: 2_000,
  timeoutMs: 15_000,
});

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function monitorConfiguration(environment = process.env) {
  const webUrl = environment.COMPADRE_MONITOR_WEB_URL || DEFAULTS.webUrl;
  return {
    webUrl,
    webOriginUrl:
      environment.COMPADRE_MONITOR_WEB_ORIGIN_URL || DEFAULTS.webOriginUrl,
    descriptorUrl:
      environment.COMPADRE_MONITOR_DESCRIPTOR_URL ||
      new URL("/.well-known/t3/environment", webUrl).toString(),
    controllerHealthUrl:
      environment.COMPADRE_MONITOR_CONTROLLER_HEALTH_URL ||
      DEFAULTS.controllerHealthUrl,
    attempts: positiveInteger(
      environment.COMPADRE_MONITOR_ATTEMPTS,
      DEFAULTS.attempts,
    ),
    retryDelayMs: positiveInteger(
      environment.COMPADRE_MONITOR_RETRY_DELAY_MS,
      DEFAULTS.retryDelayMs,
    ),
    timeoutMs: positiveInteger(
      environment.COMPADRE_MONITOR_TIMEOUT_MS,
      DEFAULTS.timeoutMs,
    ),
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function responseJson(response, label) {
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function retry(label, operation, configuration, dependencies) {
  let lastError;
  for (let attempt = 1; attempt <= configuration.attempts; attempt += 1) {
    try {
      await operation();
      dependencies.log(`ok: ${label}`);
      return;
    } catch (error) {
      lastError = error;
      dependencies.error(
        `${label} attempt ${attempt}/${configuration.attempts}: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (attempt < configuration.attempts) {
        await dependencies.delay(configuration.retryDelayMs);
      }
    }
  }
  throw lastError;
}

async function checkedFetch(url, configuration, dependencies) {
  const response = await dependencies.fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(configuration.timeoutMs),
    headers: { "user-agent": "compadre-hosted-monitor/1.0" },
  });
  assert(response.ok, `${url} returned HTTP ${response.status}`);
  return response;
}

export async function probeHostedStack(
  configuration = monitorConfiguration(),
  overrides = {},
) {
  const dependencies = {
    fetch: globalThis.fetch,
    delay: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    log: console.log,
    error: console.error,
    ...overrides,
  };

  const probes = [
    ["custom web domain", async () => {
      const response = await checkedFetch(
        configuration.webUrl,
        configuration,
        dependencies,
      );
      assert(
        (await response.text()).includes("<title>Compadre</title>"),
        "custom web domain did not return the Compadre application shell",
      );
    }],
    ["Render web origin", async () => {
      const response = await checkedFetch(
        configuration.webOriginUrl,
        configuration,
        dependencies,
      );
      assert(
        (await response.text()).includes("<title>Compadre</title>"),
        "Render web origin did not return the Compadre application shell",
      );
    }],
    ["T3 environment descriptor", async () => {
      const response = await checkedFetch(
        configuration.descriptorUrl,
        configuration,
        dependencies,
      );
      const body = await responseJson(response, "T3 environment descriptor");
      assert(
        typeof body.environmentId === "string" && body.environmentId.length > 0,
        "T3 environment descriptor is missing environmentId",
      );
      assert(
        body.capabilities?.attachmentUploads === true,
        "T3 environment does not advertise attachment uploads",
      );
      assert(
        body.capabilities?.fileAttachments?.maxUploadBytes >= 50 * 1024 * 1024,
        "T3 environment does not advertise the 50 MiB file limit",
      );
    }],
    ["controller health", async () => {
      const response = await checkedFetch(
        configuration.controllerHealthUrl,
        configuration,
        dependencies,
      );
      const body = await responseJson(response, "controller health");
      assert(body.status === "ok", "controller health status is not ok");
    }],
  ];

  const results = await Promise.allSettled(
    probes.map(([label, operation]) =>
      retry(label, operation, configuration, dependencies),
    ),
  );
  const failures = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [
          `${probes[index][0]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        ]
      : [],
  );
  if (failures.length > 0) {
    throw new Error(`Compadre hosted monitor failed:\n- ${failures.join("\n- ")}`);
  }
  return { checked: probes.map(([label]) => label) };
}

async function main() {
  const startedAt = new Date();
  try {
    const result = await probeHostedStack();
    const summary = [
      "## Compadre hosted monitor",
      "",
      `Passed at ${startedAt.toISOString()}.`,
      "",
      ...result.checked.map((label) => `- ✅ ${label}`),
      "",
    ].join("\n");
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::${message.replaceAll("\n", "%0A")}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `## Compadre hosted monitor\n\n❌ ${message}\n`,
      );
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await main();
}
