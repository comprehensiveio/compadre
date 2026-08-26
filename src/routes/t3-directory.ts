import crypto from "node:crypto";
import {
  chatParamsFromRequestBody,
  convertMessagesToModelMessages,
  toServerSentEventsResponse,
  type ModelMessage,
} from "@tanstack/ai";
import { Hono, type Context, type Handler } from "hono";
import type { T3ThreadBinding } from "../services/t3-thread-bindings.js";
import type {
  T3ModelSelection,
  T3ThreadSnapshot,
  T3TurnDispatch,
} from "../t3/client.js";
import {
  T3Gateway,
  type T3GatewayTurn,
} from "../t3/gateway.js";
import { getConfiguredT3Gateway } from "../t3/runtime.js";
import { requireCompadreApiKey } from "./auth.js";
import {
  createNativeT3AguiStream,
} from "../t3/agui-stream.js";
import { isAgentProvider } from "../tanstack/protocol.js";

const MAX_TITLE_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 100_000;
const TERMINAL_WAIT_TIMEOUT_MS = 20 * 60 * 1000;

export interface ActiveNativeT3Run {
  gateway: T3DirectoryGateway;
  turn: T3GatewayTurn;
}

interface T3DirectoryGateway {
  list(): Promise<T3ThreadBinding[]>;
  send(input: {
    canonicalThreadId: string;
    title: string;
    text: string;
    modelSelection: T3ModelSelection;
    signal?: AbortSignal;
  }): Promise<T3GatewayTurn>;
  snapshot(input: {
    canonicalThreadId: string;
    providerInstanceId: string;
    signal?: AbortSignal;
  }): Promise<{
    binding: T3ThreadBinding;
    snapshot: T3ThreadSnapshot;
    source: "central" | "worker";
  } | null>;
  open(input: {
    canonicalThreadId: string;
    providerInstanceId: string;
    signal?: AbortSignal;
  }): Promise<{ binding: T3ThreadBinding; pairingUrl: string } | null>;
  cancel(input: {
    canonicalThreadId: string;
    providerInstanceId: string;
    signal?: AbortSignal;
  }): Promise<number | null>;
  waitForTerminal(input: {
    turn: T3GatewayTurn;
    timeoutMs?: number;
    signal?: AbortSignal;
    onSnapshot?(snapshot: T3ThreadSnapshot): void | Promise<void>;
  }): Promise<T3ThreadSnapshot>;
}

export interface T3DirectoryRoutesDependencies {
  enabled(): boolean;
  getGateway(): Promise<T3DirectoryGateway | null>;
  createId(): string;
  watchTurn(gateway: T3DirectoryGateway, turn: T3GatewayTurn): void;
}

const defaultDependencies: T3DirectoryRoutesDependencies = {
  enabled: () => process.env.COMPADRE_T3_DIRECTORY_ENABLED === "true",
  getGateway: getConfiguredT3Gateway,
  createId: crypto.randomUUID,
  watchTurn(gateway, turn) {
    void gateway
      .waitForTerminal({ turn, timeoutMs: TERMINAL_WAIT_TIMEOUT_MS })
      .catch((error) => {
        console.error(
          `[t3-directory] terminal watch failed thread=${turn.binding.canonicalThreadId} provider=${turn.binding.providerInstanceId} error=${error instanceof Error ? error.name : "UnknownError"}`,
        );
      });
  },
};

function publicBinding(binding: T3ThreadBinding) {
  return {
    canonicalThreadId: binding.canonicalThreadId,
    providerInstanceId: binding.providerInstanceId,
    t3ThreadId: binding.t3ThreadId,
    title: binding.title ?? "Untitled thread",
    modelSelection: binding.modelSelection,
    status: binding.status ?? "ready",
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  };
}

function nonEmptyString(
  value: unknown,
  maximumLength: number,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) return null;
  return normalized;
}

function modelSelection(value: unknown): T3ModelSelection | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const instanceId = nonEmptyString(record.instanceId, 100);
  const model = nonEmptyString(record.model, 200);
  if (!instanceId || !model) return null;
  if (instanceId !== "codex" && instanceId !== "claudeAgent") return null;
  const options = providerOptions(record.options);
  return { instanceId, model, ...(options.length > 0 ? { options } : {}) };
}

function providerOptions(value: unknown): NonNullable<T3ModelSelection["options"]> {
  if (!Array.isArray(value)) return [];
  const options: Array<NonNullable<T3ModelSelection["options"]>[number]> = [];
  for (const entry of value.slice(0, 20)) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = nonEmptyString(record.id, 100);
    const optionValue = record.value;
    if (!id || (typeof optionValue !== "string" && typeof optionValue !== "boolean")) continue;
    if (typeof optionValue === "string") {
      const normalized = nonEmptyString(optionValue, 200);
      if (normalized) options.push({ id, value: normalized });
      continue;
    }
    options.push({ id, value: optionValue });
  }
  return options;
}

async function requestBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object"
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function routeIdentity(canonicalThreadId: string, providerInstanceId: string) {
  return { canonicalThreadId, providerInstanceId };
}

function routeParam(c: Context, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new Error(`Missing route parameter ${name}`);
  return value;
}

function textContent(message: ModelMessage | undefined): string | null {
  if (!message || message.role !== "user") return null;
  if (typeof message.content === "string") return message.content.trim() || null;
  if (!Array.isArray(message.content)) return null;
  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.content)
    .join("\n")
    .trim();
  return text || null;
}

async function latestUserMessage(messages: unknown): Promise<string | null> {
  const converted = await convertMessagesToModelMessages(messages as never);
  for (let index = converted.length - 1; index >= 0; index -= 1) {
    const message = converted[index];
    if (message?.role === "user") return textContent(message);
  }
  return null;
}

function nativeModelSelection(
  provider: "claude-code" | "codex",
  requestedModel: unknown,
  requestedOptions: unknown,
): T3ModelSelection {
  const model = nonEmptyString(requestedModel, 200);
  const options = providerOptions(requestedOptions);
  if (provider === "codex") {
    return {
      instanceId: "codex",
      model:
        model && model !== "codex"
          ? model
          : process.env.COMPADRE_T3_CODEX_MODEL?.trim() || "gpt-5.6-sol",
      ...(options.length > 0 ? { options } : {}),
    };
  }
  return {
    instanceId: "claudeAgent",
    model:
      model && model !== "claude-code"
        ? model
        : process.env.COMPADRE_T3_CLAUDE_MODEL?.trim() || "claude-opus-5",
    ...(options.length > 0 ? { options } : {}),
  };
}

function guarded(handler: (c: Context) => Promise<Response>): Handler {
  return async (c) => {
    try {
      return await handler(c);
    } catch (error) {
      console.error(
        `[t3-directory] request failed method=${c.req.method} path=${c.req.path} error=${error instanceof Error ? error.name : "UnknownError"}`,
      );
      return c.json({ error: "T3 environment operation failed" }, 502);
    }
  };
}

export function createT3DirectoryRoutes(
  dependencies: T3DirectoryRoutesDependencies = defaultDependencies,
  activeRuns: Map<string, ActiveNativeT3Run> = new Map(),
): Hono {
  const routes = new Hono();

  routes.use("/hosted/t3/*", async (c, next) => {
    if (!dependencies.enabled()) return c.notFound();
    const authError = requireCompadreApiKey(c);
    if (authError) return authError;
    return next();
  });

  routes.get("/hosted/t3/threads", guarded(async (c) => {
    const gateway = await dependencies.getGateway();
    if (!gateway) {
      return c.json({ error: "thread persistence requires durability" }, 503);
    }
    return c.json({ threads: (await gateway.list()).map(publicBinding) });
  }));

  routes.post("/hosted/t3/threads", guarded(async (c) => {
    const body = await requestBody(c.req.raw);
    const title = nonEmptyString(body?.title, MAX_TITLE_LENGTH);
    const text = nonEmptyString(body?.text, MAX_MESSAGE_LENGTH);
    const selection = modelSelection(body?.modelSelection);
    const requestedId = nonEmptyString(body?.canonicalThreadId, 200);
    if (!title || !text || !selection) {
      return c.json(
        { error: "title, text, and a supported modelSelection are required" },
        400,
      );
    }
    const gateway = await dependencies.getGateway();
    if (!gateway) {
      return c.json({ error: "thread persistence requires durability" }, 503);
    }
    const turn = await gateway.send({
      canonicalThreadId: requestedId ?? dependencies.createId(),
      title,
      text,
      modelSelection: selection,
      signal: c.req.raw.signal,
    });
    dependencies.watchTurn(gateway, turn);
    return c.json(
      { thread: publicBinding(turn.binding), dispatch: turn.dispatch },
      202,
    );
  }));

  routes.post("/hosted/t3/chat", async (c) => {
    if (!dependencies.enabled()) return c.notFound();
    const authError = requireCompadreApiKey(c);
    if (authError) return authError;
    let params;
    try {
      params = await chatParamsFromRequestBody(await c.req.json());
    } catch (error) {
      return c.json({
        error: "invalid native T3 provider body",
        detail: error instanceof Error ? error.message : String(error),
      }, 400);
    }
    const provider = params.forwardedProps.provider;
    if (!isAgentProvider(provider)) {
      return c.json({
        error: "forwardedProps.provider must be 'claude-code' or 'codex'",
      }, 400);
    }
    const text = await latestUserMessage(params.messages);
    if (!text) return c.json({ error: "a text user message is required" }, 400);
    const gateway = await dependencies.getGateway();
    if (!gateway) {
      return c.json({ error: "thread persistence requires durability" }, 503);
    }
    const runId = params.runId || dependencies.createId();
    const canonicalThreadId = params.threadId || dependencies.createId();
    const stream = createNativeT3AguiStream({
      gateway,
      canonicalThreadId,
      runId,
      title:
        nonEmptyString(params.forwardedProps.title, MAX_TITLE_LENGTH) ??
        "T3 thread",
      text,
      modelSelection: nativeModelSelection(
        provider,
        params.forwardedProps.model,
        params.forwardedProps.modelOptions,
      ),
      signal: c.req.raw.signal,
      onTurn(turn) {
        activeRuns.set(runId, { gateway, turn });
      },
      onTerminal() {
        activeRuns.delete(runId);
      },
    });
    return toServerSentEventsResponse(stream, {
      headers: {
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  routes.post("/hosted/t3/runs/:runId/cancel", guarded(async (c) => {
    const runId = routeParam(c, "runId");
    const active = activeRuns.get(runId);
    if (!active) {
      return c.json({ error: "native T3 run is not active", runId }, 409);
    }
    const sequence = await active.gateway.cancel({
      canonicalThreadId: active.turn.binding.canonicalThreadId,
      providerInstanceId: active.turn.binding.providerInstanceId,
      signal: c.req.raw.signal,
    });
    return c.json({ ok: true, sequence }, 202);
  }));

  routes.post(
    "/hosted/t3/threads/:providerInstanceId/:canonicalThreadId/messages",
    guarded(async (c) => {
      const body = await requestBody(c.req.raw);
      const text = nonEmptyString(body?.text, MAX_MESSAGE_LENGTH);
      const selection = modelSelection(body?.modelSelection);
      if (!text || !selection) {
        return c.json({ error: "text and modelSelection are required" }, 400);
      }
      const providerInstanceId = routeParam(c, "providerInstanceId");
      if (selection.instanceId !== providerInstanceId) {
        return c.json({ error: "route provider and modelSelection disagree" }, 400);
      }
      const gateway = await dependencies.getGateway();
      if (!gateway) {
        return c.json({ error: "thread persistence requires durability" }, 503);
      }
      const turn = await gateway.send({
        canonicalThreadId: routeParam(c, "canonicalThreadId"),
        title: nonEmptyString(body?.title, MAX_TITLE_LENGTH) ?? "Compadre thread",
        text,
        modelSelection: selection,
        signal: c.req.raw.signal,
      });
      dependencies.watchTurn(gateway, turn);
      return c.json(
        { thread: publicBinding(turn.binding), dispatch: turn.dispatch },
        202,
      );
    }),
  );

  routes.get(
    "/hosted/t3/threads/:providerInstanceId/:canonicalThreadId/snapshot",
    guarded(async (c) => {
      const gateway = await dependencies.getGateway();
      if (!gateway) {
        return c.json({ error: "thread persistence requires durability" }, 503);
      }
      const result = await gateway.snapshot({
        ...routeIdentity(
          routeParam(c, "canonicalThreadId"),
          routeParam(c, "providerInstanceId"),
        ),
        signal: c.req.raw.signal,
      });
      if (!result) return c.json({ error: "thread not found" }, 404);
      return c.json({
        thread: publicBinding(result.binding),
        snapshot: result.snapshot,
        source: result.source,
      });
    }),
  );

  routes.post(
    "/hosted/t3/threads/:providerInstanceId/:canonicalThreadId/cancel",
    guarded(async (c) => {
      const gateway = await dependencies.getGateway();
      if (!gateway) {
        return c.json({ error: "thread persistence requires durability" }, 503);
      }
      const sequence = await gateway.cancel({
        ...routeIdentity(
          routeParam(c, "canonicalThreadId"),
          routeParam(c, "providerInstanceId"),
        ),
        signal: c.req.raw.signal,
      });
      if (sequence === null) return c.json({ error: "thread not found" }, 404);
      return c.json({ ok: true, sequence });
    }),
  );

  routes.post(
    "/hosted/t3/threads/:providerInstanceId/:canonicalThreadId/open",
    guarded(async (c) => {
      const gateway = await dependencies.getGateway();
      if (!gateway) {
        return c.json({ error: "thread persistence requires durability" }, 503);
      }
      const result = await gateway.open({
        ...routeIdentity(
          routeParam(c, "canonicalThreadId"),
          routeParam(c, "providerInstanceId"),
        ),
        signal: c.req.raw.signal,
      });
      if (!result) return c.json({ error: "thread not found" }, 404);
      return c.json({ pairingUrl: result.pairingUrl });
    }),
  );

  return routes;
}

export const t3DirectoryRoutes = createT3DirectoryRoutes();
