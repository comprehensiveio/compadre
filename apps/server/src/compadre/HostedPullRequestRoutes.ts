import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import { PullRequestsToolkitLocalHandlersLive } from "../mcp/toolkits/pullRequests/handlers.ts";
import { PullRequestsToolkit } from "../mcp/toolkits/pullRequests/tools.ts";
import { HostedPullRequestRequest } from "./HostedPullRequestClient.ts";

const tokenPayload = Schema.Struct({
  threadId: ThreadId,
  expiresAt: Schema.Number.check(Schema.isInt()),
});
const headers = { "cache-control": "no-store", "x-compadre-pull-requests-version": "1" };
const decodeToken = Schema.decodeEffect(Schema.fromJsonString(tokenPayload));
const decodeRequest = Schema.decodeUnknownEffect(HostedPullRequestRequest);

/** Controller-issued bearer grants only PR association access to one canonical thread. */
const authenticate = Effect.fn("HostedPullRequests.authenticate")(function* (
  authorization: string | undefined,
) {
  const secret = process.env.COMPADRE_API_KEY?.trim();
  if (!secret || !authorization?.startsWith("Bearer ") || authorization.length > 4096)
    return undefined;
  const [payload, signature, extra] = authorization.slice(7).split(".");
  if (!payload || !signature || extra) return undefined;
  const expected = NodeCrypto.createHmac("sha256", secret)
    .update(`compadre:pull-requests:v1:${payload}`)
    .digest();
  const supplied = Buffer.from(signature, "base64url");
  if (expected.length !== supplied.length || !NodeCrypto.timingSafeEqual(expected, supplied))
    return undefined;
  const decoded = yield* decodeToken(Buffer.from(payload, "base64url").toString("utf8")).pipe(
    Effect.option,
  );
  if (Option.isNone(decoded) || decoded.value.expiresAt <= (yield* Clock.currentTimeMillis) / 1000)
    return undefined;
  return decoded.value.threadId;
});

const handle = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const threadId = yield* authenticate(request.headers.authorization);
  if (!threadId) return HttpServerResponse.empty({ status: 401, headers });
  const input = yield* request.json.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, FileSystem.Size(16 * 1024)),
    Effect.flatMap(decodeRequest),
    Effect.option,
  );
  if (Option.isNone(input)) return HttpServerResponse.empty({ status: 400, headers });
  const toolkit = yield* PullRequestsToolkit;
  const action = input.value;
  const invoke = <Name extends keyof typeof PullRequestsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((results) =>
        HttpServerResponse.jsonUnsafe({ result: results.at(-1)!.result }, { headers }),
      ),
    );
  const call =
    action.operation === "list"
      ? invoke("list_thread_pull_requests", {})
      : action.operation === "link"
        ? invoke("link_pull_request", action.input)
        : invoke("unlink_pull_request", action.input);
  return yield* call.pipe(
    Effect.catch((error) =>
      Effect.succeed(HttpServerResponse.jsonUnsafe({ error: error.message }, { headers })),
    ),
    Effect.provideService(McpInvocationContext, {
      environmentId: EnvironmentId.make("compadre-central"),
      threadId,
      providerInstanceId: ProviderInstanceId.make("compadre-worker"),
      providerSessionId: `compadre-pull-requests:${threadId}`,
      capabilities: new Set(["pull-requests"] as const),
      issuedAt: yield* Clock.currentTimeMillis,
    }),
  );
});

export const hostedPullRequestRoutes = HttpRouter.add(
  "POST",
  "/api/compadre/pull-requests",
  handle.pipe(Effect.provide(PullRequestsToolkitLocalHandlersLive)),
);
