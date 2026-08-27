import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { makeCompadreTextGeneration } from "./CompadreTextGeneration.ts";

describe("CompadreTextGeneration", () => {
  it.effect("uses hidden native-provider text generation for thread titles", () => {
    const requests: Array<{ url: string; authorization: string | undefined; body: unknown }> = [];
    const clientLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        const body =
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : undefined;
        requests.push({
          url: request.url,
          authorization: request.headers.authorization,
          body,
        });
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ result: '{"title":"Deployment alerts"}' }),
          ),
        );
      }),
    );

    return Effect.gen(function* () {
      const textGeneration = yield* makeCompadreTextGeneration({
        endpoint: "https://compadre.example/hosted/chat",
        apiKey: "secret",
        provider: "claude-code",
      });
      const result = yield* textGeneration.generateThreadTitle({
        cwd: "/workspace",
        message: "Alert this Slack thread when the deploy finishes",
        modelSelection: createModelSelection(ProviderInstanceId.make("compadre"), "gpt-5.6-sol", [
          { id: "reasoningEffort", value: "high" },
        ]),
      });

      expect(result).toEqual({ title: "Deployment alerts" });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://compadre.example/hosted/t3/text-generation");
      expect(requests[0]?.authorization).toBe("Bearer secret");
      expect(requests[0]?.body).toMatchObject({
        provider: "codex",
        model: "gpt-5.6-luna",
        modelOptions: [{ id: "reasoningEffort", value: "low" }],
      });
    }).pipe(Effect.provide(clientLayer));
  });
});
