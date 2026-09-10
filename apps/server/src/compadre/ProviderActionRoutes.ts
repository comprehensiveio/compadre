import { AuthOrchestrationOperateScope, ThreadTurnStartCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/unstable/http";
import { authenticateRawRouteWithScope } from "../http.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";

const path = "/api/compadre/provider-actions";
const decodeActionCommand = Schema.decodeUnknownEffect(ThreadTurnStartCommand);
const headers = { "cache-control": "no-store" };
const authErrors = {
  EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
  EnvironmentInternalError: HttpServerRespondable.toResponse,
  EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
};

const capabilities = Effect.gen(function* () {
  yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
  return HttpServerResponse.jsonUnsafe({ version: 1, actions: ["compact"] }, { headers });
}).pipe(Effect.catchTags(authErrors));

/** A separate endpoint fails closed on old workers that would strip action fields. */
const dispatch = Effect.gen(function* () {
  yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const command = yield* request.json.pipe(Effect.flatMap(decodeActionCommand), Effect.option);
  if (
    Option.isNone(command) ||
    !command.value.providerAction ||
    command.value.message.attachments.length > 0
  ) {
    return HttpServerResponse.jsonUnsafe(
      { error: "A supported provider action without attachments is required." },
      { status: 400 },
    );
  }
  const engine = yield* OrchestrationEngineService;
  return HttpServerResponse.jsonUnsafe(yield* engine.dispatch(command.value), { headers });
}).pipe(Effect.catchTags(authErrors));

export const providerActionRoutes = Layer.mergeAll(
  HttpRouter.add("GET", path, capabilities),
  HttpRouter.add("POST", path, dispatch),
);
