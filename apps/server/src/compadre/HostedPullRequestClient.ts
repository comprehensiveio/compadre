import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpBody,
} from "effect/unstable/http";
import { PullRequestTargetInput } from "../mcp/toolkits/pullRequests/tools.ts";

export const HostedPullRequestRequest = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("link"), input: PullRequestTargetInput }),
  Schema.Struct({ operation: Schema.Literal("unlink"), input: PullRequestTargetInput }),
  Schema.Struct({ operation: Schema.Literal("list") }),
]);

const decodeResponse = Schema.decodeUnknownEffect(
  Schema.Union([
    Schema.Struct({ result: Schema.Unknown }),
    Schema.Struct({ error: Schema.String }),
  ]),
);

class HostedPullRequestError extends Schema.TaggedError<HostedPullRequestError>()(
  "HostedPullRequestError",
  { detail: Schema.String },
) {}

/** Hosted tools share central state with browser actions; a failed call never writes locally. */
export const callHostedPullRequest = <A, I>(
  operation: (typeof HostedPullRequestRequest.Type)["operation"],
  success: Schema.Codec<A, I>,
  input?: PullRequestTargetInput,
) =>
  Effect.gen(function* () {
    const endpoint = process.env.COMPADRE_PULL_REQUESTS_URL?.trim();
    const token = process.env.COMPADRE_PULL_REQUESTS_TOKEN?.trim();
    if (!endpoint && !token && !process.env.COMPADRE_CANONICAL_THREAD_ID) return undefined;
    if (!endpoint || !token) {
      return yield* new HostedPullRequestError({
        detail: "Hosted pull request access is not configured. Restore or upgrade the worker.",
      });
    }
    const http = yield* HttpClient.HttpClient;
    const response = yield* http
      .execute(
        HttpClientRequest.post(endpoint, {
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: HttpBody.jsonUnsafe({ operation, ...(input ? { input } : {}) }),
        }),
      )
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
    const body = yield* response.json;
    const decoded = yield* decodeResponse(body);
    if ("error" in decoded) return yield* new HostedPullRequestError({ detail: decoded.error });
    return yield* Schema.decodeUnknownEffect(success)(decoded.result);
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.timeout("30 seconds"),
  );
