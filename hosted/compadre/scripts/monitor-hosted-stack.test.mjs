import assert from "node:assert/strict";
import test from "node:test";
import {
  monitorConfiguration,
  probeHostedStack,
} from "./monitor-hosted-stack.mjs";

const configuration = {
  webUrl: "https://web.example/",
  webOriginUrl: "https://origin.example/",
  descriptorUrl: "https://web.example/.well-known/t3/environment",
  controllerHealthUrl: "https://api.example/health",
  attempts: 1,
  retryDelayMs: 1,
  timeoutMs: 1_000,
};

function successfulFetch(url) {
  if (url.endsWith("/.well-known/t3/environment")) {
    return Promise.resolve(
      Response.json({
        environmentId: "environment-1",
        capabilities: {
          attachmentUploads: true,
          fileAttachments: { maxUploadBytes: 50 * 1024 * 1024 },
        },
      }),
    );
  }
  if (url.endsWith("/health")) {
    return Promise.resolve(Response.json({ status: "ok" }));
  }
  return Promise.resolve(
    new Response("<html><head><title>Compadre</title></head></html>"),
  );
}

const quietDependencies = {
  fetch: successfulFetch,
  delay: () => Promise.resolve(),
  log: () => {},
  error: () => {},
};

test("uses production endpoints by default", () => {
  const result = monitorConfiguration({});
  assert.equal(result.webUrl, "https://compadre.comprehensive.io/");
  assert.equal(
    result.controllerHealthUrl,
    "https://compadre-api.comprehensive.io/health",
  );
});

test("passes when the public stack contracts are healthy", async () => {
  const result = await probeHostedStack(configuration, quietDependencies);
  assert.deepEqual(result.checked, [
    "custom web domain",
    "Render web origin",
    "T3 environment descriptor",
    "controller health",
  ]);
});

test("retries a transient failure", async () => {
  let calls = 0;
  const result = await probeHostedStack(
    { ...configuration, attempts: 2 },
    {
      ...quietDependencies,
      fetch: (url) => {
        calls += 1;
        if (url === configuration.webUrl && calls === 1) {
          return Promise.resolve(new Response("unavailable", { status: 503 }));
        }
        return successfulFetch(url);
      },
    },
  );
  assert.equal(result.checked.length, 4);
  assert.equal(calls, 5);
});

test("fails when generic file attachments are not advertised", async () => {
  await assert.rejects(
    probeHostedStack(configuration, {
      ...quietDependencies,
      fetch: (url) =>
        url.endsWith("/.well-known/t3/environment")
          ? Promise.resolve(
              Response.json({
                environmentId: "environment-1",
                capabilities: { attachmentUploads: true },
              }),
            )
          : successfulFetch(url),
    }),
    /50 MiB file limit/,
  );
});
