import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as Cookies from "effect/unstable/http/Cookies";
import * as Socket from "effect/unstable/socket/Socket";

import * as SessionStore from "./SessionStore.ts";
import { decodeCompadreUserSubject, isAllowedCompadreSession } from "./CompadreAuth.ts";
import {
  previewActivationHtml,
  type PreviewActivationState,
} from "./CompadrePreviewActivationPage.ts";

const TARGET_CACHE_MS = 30_000;
const MAX_BUFFERED_REQUEST_BYTES = 25 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface PreviewGatewayConfig {
  controllerUrl: URL;
  serviceToken: string;
  hostSuffix: string;
}

interface CachedTarget {
  url: string;
  expiresAt: number;
}

type PreviewResolution =
  | { readonly state: "ready"; readonly url: string }
  | {
      readonly state: PreviewActivationState;
      readonly error?: string;
    };

const targetCache = new Map<string, CachedTarget>();

class PreviewGatewayError extends Data.TaggedError("PreviewGatewayError")<{
  readonly message: string;
}> {}

export function previewGatewayConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): PreviewGatewayConfig | null {
  const rawControllerUrl = environment.COMPADRE_CONTROLLER_URL?.trim();
  const serviceToken = environment.COMPADRE_PREVIEW_GATEWAY_SECRET?.trim();
  const hostSuffix = environment.COMPADRE_PREVIEW_HOST_SUFFIX?.trim()
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase();
  if (!rawControllerUrl || !serviceToken || !hostSuffix) return null;
  try {
    return { controllerUrl: new URL(rawControllerUrl), serviceToken, hostSuffix };
  } catch {
    return null;
  }
}

export function previewThreadIdFromHost(host: string, hostSuffix: string): string | null {
  const hostname = host.split(":", 1)[0]?.toLowerCase() ?? "";
  const suffix = hostSuffix.replace(/^\.+|\.+$/g, "").toLowerCase();
  if (!hostname.endsWith(`.${suffix}`)) return null;
  const label = hostname.slice(0, -(suffix.length + 1));
  return UUID_PATTERN.test(label) ? label : null;
}

export function withoutCookie(cookieHeader: string | undefined, cookieName: string): string | null {
  if (!cookieHeader) return null;
  const retained = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      if (!part) return false;
      const separator = part.indexOf("=");
      return separator < 0 || part.slice(0, separator).trim() !== cookieName;
    });
  return retained.length > 0 ? retained.join("; ") : null;
}

export function rewritePreviewRequestHeaders(
  source: ConstructorParameters<typeof Headers>[0],
  sessionCookieName: string,
  previewOrigin: string,
  targetOrigin: string,
): Headers {
  const headers = new Headers(source);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("upgrade");
  headers.delete("content-length");
  const cookie = withoutCookie(headers.get("cookie") ?? undefined, sessionCookieName);
  if (cookie) headers.set("cookie", cookie);
  else headers.delete("cookie");

  if (headers.get("origin") === previewOrigin) headers.set("origin", targetOrigin);
  const referer = headers.get("referer");
  if (referer) {
    try {
      const url = new URL(referer);
      if (url.origin === previewOrigin) {
        headers.set("referer", `${targetOrigin}${url.pathname}${url.search}${url.hash}`);
      }
    } catch {
      // Preserve malformed or non-HTTP referers rather than guessing.
    }
  }
  headers.set("x-forwarded-host", new URL(previewOrigin).host);
  headers.set("x-forwarded-proto", "https");
  return headers;
}

export function rewritePreviewResponse(
  response: Response,
  targetOrigin: string,
  previewOrigin: string,
): Response {
  const headers = new Headers(response.headers);
  const location = headers.get("location");
  if (location) {
    try {
      const resolved = new URL(location, targetOrigin);
      if (resolved.origin === new URL(targetOrigin).origin) {
        headers.set(
          "location",
          `${previewOrigin}${resolved.pathname}${resolved.search}${resolved.hash}`,
        );
      }
    } catch {
      // Leave malformed or non-HTTP Location values untouched.
    }
  }
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) {
    headers.delete("set-cookie");
    const targetHostname = new URL(targetOrigin).hostname;
    for (const cookie of cookies) {
      headers.append(
        "set-cookie",
        cookie.replace(
          new RegExp(`;\\s*Domain=${targetHostname.replaceAll(".", "\\.")}`, "ig"),
          "",
        ),
      );
    }
  }
  headers.set("cache-control", headers.get("cache-control") ?? "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function fetchPreviewResolution(
  config: PreviewGatewayConfig,
  canonicalThreadId: string,
  httpClient: HttpClient.HttpClient,
  now: number,
  useCache = true,
) {
  return Effect.gen(function* () {
    const cached = targetCache.get(canonicalThreadId);
    if (useCache && cached && cached.expiresAt > now) {
      return { state: "ready", url: cached.url } satisfies PreviewResolution;
    }
    const endpoint = new URL(
      `/internal/previews/${encodeURIComponent(canonicalThreadId)}/target`,
      config.controllerUrl,
    );
    const request = HttpClientRequest.get(endpoint).pipe(
      HttpClientRequest.bearerToken(config.serviceToken),
    );
    const response = yield* httpClient.execute(request);
    const body = (yield* response.json) as {
      ok?: unknown;
      state?: unknown;
      targetUrl?: unknown;
      error?: unknown;
    };
    if (response.status === 202 || response.status === 410) {
      const state = String(body.state);
      if (
        !["idle", "requested", "restoring", "starting", "failed", "unavailable"].includes(state)
      ) {
        return yield* new PreviewGatewayError({
          message: "Preview activation state was invalid",
        });
      }
      return {
        state: state as PreviewActivationState,
        ...(typeof body.error === "string" ? { error: body.error } : {}),
      } satisfies PreviewResolution;
    }
    if (response.status !== 200) {
      return yield* new PreviewGatewayError({
        message: `Preview target resolution failed (${response.status})`,
      });
    }
    if (body.ok !== true || typeof body.targetUrl !== "string") {
      return yield* new PreviewGatewayError({ message: "Preview target response was invalid" });
    }
    const target = yield* Effect.try({
      try: () => new URL(body.targetUrl as string),
      catch: () => new PreviewGatewayError({ message: "Preview target URL was invalid" }),
    });
    if (target.protocol !== "https:") {
      return yield* new PreviewGatewayError({ message: "Preview target must use HTTPS" });
    }
    targetCache.set(canonicalThreadId, {
      url: target.origin,
      expiresAt: now + TARGET_CACHE_MS,
    });
    return { state: "ready", url: target.origin } satisfies PreviewResolution;
  });
}

function requestPreviewActivation(
  config: PreviewGatewayConfig,
  canonicalThreadId: string,
  httpClient: HttpClient.HttpClient,
) {
  targetCache.delete(canonicalThreadId);
  const endpoint = new URL(
    `/internal/previews/${encodeURIComponent(canonicalThreadId)}/activate`,
    config.controllerUrl,
  );
  const request = HttpClientRequest.post(endpoint).pipe(
    HttpClientRequest.bearerToken(config.serviceToken),
  );
  return Effect.gen(function* () {
    const response = yield* httpClient.execute(request);
    if (response.status !== 200 && response.status !== 202) {
      return yield* new PreviewGatewayError({
        message: `Preview activation failed (${response.status})`,
      });
    }
  });
}

function proxyHeaders(
  request: HttpServerRequest.HttpServerRequest,
  sessionCookieName: string,
  previewOrigin: string,
  targetOrigin: string,
): Headers {
  return rewritePreviewRequestHeaders(
    request.headers as Record<string, string>,
    sessionCookieName,
    previewOrigin,
    targetOrigin,
  );
}

function proxyHttpRequest(input: {
  request: HttpServerRequest.HttpServerRequest;
  targetOrigin: string;
  previewOrigin: string;
  sessionCookieName: string;
  httpClient: HttpClient.HttpClient;
}) {
  return Effect.gen(function* () {
    const body =
      input.request.method === "GET" || input.request.method === "HEAD"
        ? undefined
        : new Uint8Array(yield* input.request.arrayBuffer);
    if (body && body.byteLength > MAX_BUFFERED_REQUEST_BYTES) {
      return HttpServerResponse.text("Preview request body is too large.", { status: 413 });
    }
    const targetUrl = new URL(input.request.originalUrl || input.request.url, input.targetOrigin);
    const upstreamRequest = HttpClientRequest.make(input.request.method)(targetUrl, {
      headers: proxyHeaders(
        input.request,
        input.sessionCookieName,
        input.previewOrigin,
        input.targetOrigin,
      ),
      ...(body
        ? {
            body: HttpBody.uint8Array(
              body,
              input.request.headers["content-type"] ?? "application/octet-stream",
            ),
          }
        : {}),
    });
    const response = yield* input.httpClient
      .execute(upstreamRequest)
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
    let proxied = HttpServerResponse.fromClientResponse(response);
    const location = response.headers.location;
    if (location) {
      const resolved = yield* Effect.try({
        try: () => new URL(location, input.targetOrigin),
        catch: () => new PreviewGatewayError({ message: "Preview redirect was invalid" }),
      });
      if (resolved.origin === new URL(input.targetOrigin).origin) {
        proxied = HttpServerResponse.setHeader(
          proxied,
          "location",
          `${input.previewOrigin}${resolved.pathname}${resolved.search}${resolved.hash}`,
        );
      }
    }
    const targetHostname = new URL(input.targetOrigin).hostname.toLowerCase();
    const scopedCookies = Cookies.fromIterable(
      Object.values(response.cookies.cookies).map((cookie) =>
        cookie.options?.domain?.toLowerCase() === targetHostname
          ? Cookies.makeCookieUnsafe(cookie.name, cookie.value, {
              ...cookie.options,
              domain: undefined,
            })
          : cookie,
      ),
    );
    return HttpServerResponse.replaceCookies(proxied, scopedCookies);
  });
}

function proxyWebSocketRequest(input: {
  request: HttpServerRequest.HttpServerRequest;
  targetOrigin: string;
}) {
  return Effect.scoped(
    Effect.gen(function* () {
      const targetUrl = new URL(input.request.originalUrl || input.request.url, input.targetOrigin);
      targetUrl.protocol = targetUrl.protocol === "https:" ? "wss:" : "ws:";
      const protocols = input.request.headers["sec-websocket-protocol"]
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const downstream = yield* input.request.upgrade;
      const upstream = yield* Socket.makeWebSocket(
        targetUrl.toString(),
        protocols && protocols.length > 0 ? { protocols } : {},
      ).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal));
      const writeDownstream = yield* downstream.writer;
      const writeUpstream = yield* upstream.writer;
      yield* Effect.raceFirst(
        downstream.runRaw((message) => writeUpstream(message)),
        upstream.runRaw((message) => writeDownstream(message)),
      );
      return HttpServerResponse.empty({ status: 101 });
    }),
  );
}

export const compadrePreviewGatewayLayer = Layer.unwrap(
  Effect.gen(function* () {
    const sessions = yield* SessionStore.SessionStore;
    const httpClient = yield* HttpClient.HttpClient;
    return HttpRouter.middleware(
      (httpEffect) =>
        Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
          const config = previewGatewayConfiguration();
          if (!config) return httpEffect;
          const canonicalThreadId = previewThreadIdFromHost(
            request.headers.host ?? "",
            config.hostSuffix,
          );
          if (!canonicalThreadId) return httpEffect;

          return Effect.gen(function* () {
            const token = request.cookies[sessions.cookieName];
            const verified = token
              ? yield* sessions.verify(token).pipe(Effect.option)
              : Option.none();
            const user =
              Option.isSome(verified) && isAllowedCompadreSession(verified.value)
                ? decodeCompadreUserSubject(verified.value.subject)
                : null;
            const requestUrl = HttpServerRequest.toURL(request);
            const previewUrl = Option.isSome(requestUrl)
              ? requestUrl.value
              : new URL(`https://${request.headers.host ?? config.hostSuffix}${request.url}`);
            if (!user) {
              if (request.method !== "GET" && request.method !== "HEAD") {
                return HttpServerResponse.text("Authentication required.", { status: 401 });
              }
              const login = new URL("/auth/slack/start", config.controllerUrl);
              login.searchParams.set("return_to", previewUrl.toString());
              return HttpServerResponse.redirect(login.toString(), {
                status: 302,
                headers: { "cache-control": "no-store" },
              });
            }

            const startedAt = yield* Clock.currentTimeMillis;
            if (previewUrl.pathname === "/.compadre/preview/activate") {
              if (
                request.method !== "POST" ||
                request.headers["x-compadre-preview-action"] !== "start"
              ) {
                return HttpServerResponse.text("Method not allowed.", { status: 405 });
              }
              const activated = yield* requestPreviewActivation(
                config,
                canonicalThreadId,
                httpClient,
              ).pipe(
                Effect.match({
                  onFailure: () =>
                    HttpServerResponse.jsonUnsafe({ ok: false, state: "failed" }, { status: 503 }),
                  onSuccess: () =>
                    HttpServerResponse.jsonUnsafe(
                      { ok: true, state: "requested" },
                      { status: 202 },
                    ),
                }),
              );
              return activated;
            }

            const resolution: PreviewResolution = yield* fetchPreviewResolution(
              config,
              canonicalThreadId,
              httpClient,
              startedAt,
              previewUrl.pathname !== "/.compadre/preview/status",
            ).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Compadre preview target unavailable", {
                  canonicalThreadId,
                  actorId: user.id,
                  cause,
                }).pipe(
                  Effect.as<PreviewResolution>({
                    state: "unavailable",
                    error: "This development environment is unavailable.",
                  }),
                ),
              ),
            );
            if (previewUrl.pathname === "/.compadre/preview/status") {
              return HttpServerResponse.jsonUnsafe(
                resolution.state === "ready"
                  ? { ok: true, state: "ready" }
                  : { ok: false, ...resolution },
                { status: resolution.state === "unavailable" ? 410 : 200 },
              );
            }
            if (resolution.state !== "ready") {
              if (request.method !== "GET" && request.method !== "HEAD") {
                return HttpServerResponse.text("The development environment is starting.", {
                  status: 503,
                });
              }
              return HttpServerResponse.text(
                previewActivationHtml(resolution.state, resolution.error),
                {
                  status: resolution.state === "unavailable" ? 410 : 200,
                  contentType: "text/html; charset=utf-8",
                  headers: {
                    "cache-control": "no-store",
                    "content-security-policy":
                      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
                  },
                },
              );
            }
            const targetOrigin = resolution.url;

            yield* Effect.logInfo("Compadre preview request", {
              canonicalThreadId,
              actorId: user.id,
              method: request.method,
              path: previewUrl.pathname,
            });
            const isWebSocket = request.headers.upgrade?.toLowerCase() === "websocket";
            const response = isWebSocket
              ? yield* proxyWebSocketRequest({ request, targetOrigin }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Compadre preview WebSocket proxy failed", {
                      canonicalThreadId,
                      actorId: user.id,
                      cause,
                    }).pipe(
                      Effect.as(
                        HttpServerResponse.text(
                          "The development environment could not be reached.",
                          { status: 502 },
                        ),
                      ),
                    ),
                  ),
                )
              : yield* proxyHttpRequest({
                  request,
                  targetOrigin,
                  previewOrigin: previewUrl.origin,
                  sessionCookieName: sessions.cookieName,
                  httpClient,
                }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.sync(() => targetCache.delete(canonicalThreadId)).pipe(
                      Effect.andThen(
                        Effect.logWarning("Compadre preview HTTP proxy failed", {
                          canonicalThreadId,
                          actorId: user.id,
                          cause,
                        }),
                      ),
                      Effect.as(
                        request.method === "GET" || request.method === "HEAD"
                          ? HttpServerResponse.text(previewActivationHtml("idle"), {
                              status: 200,
                              contentType: "text/html; charset=utf-8",
                              headers: {
                                "cache-control": "no-store",
                                "content-security-policy":
                                  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
                              },
                            })
                          : HttpServerResponse.text(
                              "The development environment could not be reached.",
                              { status: 502 },
                            ),
                      ),
                    ),
                  ),
                );
            const completedAt = yield* Clock.currentTimeMillis;
            yield* Effect.logInfo("Compadre preview request completed", {
              canonicalThreadId,
              actorId: user.id,
              method: request.method,
              path: previewUrl.pathname,
              status: response.status,
              durationMs: completedAt - startedAt,
            });
            return response;
          });
        }),
      { global: true },
    );
  }),
);
