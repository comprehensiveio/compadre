import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  makeRemoteProviderModelCheck,
  type RemoteNativeProviderOptions,
} from "./RemoteNativeProvider.ts";
import type { ModelManifest, ModelManifestData } from "./ModelManifest.ts";

const options = (
  agentProvider: "codex" | "claude-code" = "codex",
): RemoteNativeProviderOptions => ({
  endpoint: "https://controller.test/ag-ui",
  apiKey: "test-key",
  agentProvider,
  driverKind: ProviderDriverKind.make(agentProvider === "codex" ? "codex" : "claudeAgent"),
  instanceId: ProviderInstanceId.make(agentProvider === "codex" ? "codex" : "claudeAgent"),
  enabled: true,
  attachmentsDir: "/unused",
  snapshot: { models: [], skills: [], slashCommands: [] } as unknown as ServerProvider,
});
const manifestService = (read: () => ModelManifestData): ModelManifest["Service"] => ({
  current: Effect.sync(read),
  refresh: Effect.sync(read),
  refreshInBackground: Effect.void,
});
const nativeModel = (model: string) => ({
  id: model,
  model,
  displayName: model,
  description: "",
  hidden: false,
  isDefault: true,
  defaultReasoningEffort: "high",
  supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
  serviceTiers: [{ id: "priority", name: "Fast", description: "Lower latency" }],
});

it.effect(
  "refreshes arbitrary native Codex models, retaining capabilities and recovering from failure",
  () =>
    Effect.gen(function* () {
      let body: unknown = {
        version: "1.0.0",
        data: [nativeModel("future-first")],
        nextCursor: null,
      };
      let status = 200;
      const requests: string[] = [];
      const client = HttpClient.make((request) => {
        requests.push(request.url);
        assert.equal(request.headers.authorization, "Bearer test-key");
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status })));
      });
      const check = makeRemoteProviderModelCheck(
        options(),
        client,
        manifestService(() => ({
          version: 1,
          currentModels: {},
        })),
      );
      assert.deepEqual(check.initialSnapshot.models, []);
      const first = yield* check.checkProvider;
      assert.equal(first.models[0]?.slug, "future-first");
      assert.equal(first.models[0]?.isDefault, true);
      assert.equal(first.models[0]?.capabilities?.optionDescriptors?.[1]?.id, "serviceTier");
      status = 503;
      const unavailable = yield* check.checkProvider;
      assert.equal(unavailable.status, "warning");
      assert.deepEqual(unavailable.models, first.models);
      status = 200;
      body = { version: "1.1.0", data: [nativeModel("future-second")], nextCursor: null };
      const refreshed = yield* check.checkProvider;
      assert.equal(refreshed.status, "ready");
      assert.equal(refreshed.models[0]?.slug, "future-second");
      assert.equal(refreshed.version, "1.1.0");
      assert.ok(
        requests.every((url) => url === "https://controller.test/hosted/t3/providers/codex/models"),
      );
    }),
);

it.effect("discovers new Claude models from refreshed manifests with worker version gating", () =>
  Effect.gen(function* () {
    let version = "3.0.0";
    let slug = "claude-future-first";
    const client = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version }))),
    );
    const check = makeRemoteProviderModelCheck(
      options("claude-code"),
      client,
      manifestService(() => ({
        version: 1,
        currentModels: {},
        providers: {
          claudeAgent: {
            profiles: {
              future: {
                capabilities: {
                  optionDescriptors: [
                    {
                      id: "effort",
                      label: "Reasoning",
                      type: "select",
                      options: [{ id: "extreme", label: "Extreme", isDefault: true }],
                    },
                  ],
                },
              },
            },
            models: [
              {
                slug,
                name: "Future Claude",
                status: "current",
                profile: "future",
                adapter: { claudeCode: { minVersion: "3.1.0" } },
              },
            ],
          },
        },
      })),
    );
    assert.deepEqual((yield* check.checkProvider).models, []);
    version = "3.1.0";
    assert.equal((yield* check.checkProvider).models[0]?.slug, slug);
    slug = "claude-future-second";
    const refreshed = yield* check.checkProvider;
    assert.equal(refreshed.models[0]?.slug, slug);
    assert.equal(refreshed.models[0]?.capabilities?.optionDescriptors?.[0]?.id, "effort");
  }),
);

it.effect("keeps disabled providers offline and reports initial discovery failures", () =>
  Effect.gen(function* () {
    let requests = 0;
    const client = HttpClient.make((request) => {
      requests++;
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 503 })));
    });
    const manifest = manifestService(() => ({ version: 1, currentModels: {} }));
    const disabled = makeRemoteProviderModelCheck(
      { ...options(), enabled: false },
      client,
      manifest,
    );
    assert.equal((yield* disabled.checkProvider).status, "disabled");
    assert.equal(requests, 0);
    const active = makeRemoteProviderModelCheck(options(), client, manifest);
    const unavailable = yield* active.checkProvider;
    assert.equal(unavailable.status, "warning");
    assert.deepEqual(unavailable.models, []);
  }),
);
