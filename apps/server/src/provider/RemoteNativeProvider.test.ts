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
        subscription: { status: "idle" },
        data: [nativeModel("future-first")],
        nextCursor: null,
        account: {
          account: {
            type: "chatgpt",
            email: "codex@example.com",
            planType: "pro",
          },
          requiresOpenaiAuth: false,
        },
        rateLimits: {
          rateLimits: {
            limitId: "codex",
            planType: "pro",
            primary: {
              usedPercent: 31,
              windowDurationMins: 300,
              resetsAt: 1_800_000_000,
            },
            secondary: {
              usedPercent: 12,
              windowDurationMins: 10_080,
              resetsAt: 1_800_500_000,
            },
          },
        },
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
      assert.equal(first.auth.label, "ChatGPT Pro 20x Subscription");
      assert.equal(first.auth.email, "codex@example.com");
      assert.deepEqual(
        first.usageLimits?.windows.map((window) => [window.kind, window.usedPercent]),
        [
          ["session", 31],
          ["weekly", 12],
        ],
      );
      status = 503;
      const unavailable = yield* check.checkProvider;
      assert.equal(unavailable.status, "warning");
      assert.deepEqual(unavailable.models, first.models);
      assert.deepEqual(unavailable.usageLimits, first.usageLimits);
      status = 200;
      body = { version: "1.1.0", data: [nativeModel("future-second")], nextCursor: null };
      const refreshed = yield* check.checkProvider;
      assert.equal(refreshed.status, "ready");
      assert.equal(refreshed.models[0]?.slug, "future-second");
      assert.equal(refreshed.version, "1.1.0");
      assert.deepEqual(refreshed.usageLimits, first.usageLimits);
      body = {
        version: "1.1.0",
        data: [nativeModel("future-second")],
        nextCursor: null,
        subscription: { status: "busy" },
      };
      const busy = yield* check.checkProvider;
      assert.deepEqual(busy.usageLimits?.windows, first.usageLimits?.windows);
      assert.equal(busy.usageLimits?.checkedAt, first.usageLimits?.checkedAt);
      assert.match(busy.usageLimits?.unavailable?.message ?? "", /assigned to a Codex run/);
      body = { ...(body as object), subscription: { status: "disabled" } };
      const disabled = yield* check.checkProvider;
      assert.deepEqual(disabled.usageLimits?.windows, []);
      assert.ok(
        requests.every((url) => url === "https://controller.test/hosted/t3/providers/codex/models"),
      );
    }),
);

it.effect(
  "publishes managed Codex subscription routing when a live limits read is unavailable",
  () =>
    Effect.gen(function* () {
      let subscription = "busy" as "busy" | "disabled" | "error";
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              version: "1.0.0",
              data: [nativeModel("future-first")],
              nextCursor: null,
              subscription: { status: subscription },
            }),
          ),
        ),
      );
      const check = makeRemoteProviderModelCheck(
        options(),
        client,
        manifestService(() => ({ version: 1, currentModels: {} })),
      );

      const busy = yield* check.checkProvider;
      assert.equal(busy.auth.label, "Shared ChatGPT subscription");
      assert.equal(busy.usageLimits?.unavailable?.reason, "probeFailed");
      assert.match(busy.usageLimits?.unavailable?.message ?? "", /assigned to a Codex run/);

      subscription = "error";
      const failed = yield* check.checkProvider;
      assert.equal(failed.auth.label, "Shared ChatGPT subscription");
      assert.equal(failed.usageLimits?.unavailable?.reason, "probeFailed");

      subscription = "disabled";
      const disabled = yield* check.checkProvider;
      assert.equal(disabled.auth.label, "Isolated Modal worker");
      assert.equal(disabled.usageLimits?.unavailable?.reason, "probeFailed");
      assert.match(disabled.usageLimits?.unavailable?.message ?? "", /use API billing/);
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
