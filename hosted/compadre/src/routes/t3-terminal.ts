import { Hono } from "hono";
import { requireCompadreApiKey } from "./auth.js";
import {
  terminalRequestSchema,
  TerminalAccessError,
  T3TerminalService,
} from "../t3/terminal-service.js";
import { getConfiguredT3Gateway } from "../t3/runtime.js";

let configuredService: Promise<T3TerminalService | null> | undefined;
export function getConfiguredTerminalService() {
  return (configuredService ??= getConfiguredT3Gateway()
    .then((gateway) => (gateway ? new T3TerminalService(gateway) : null))
    .catch((error) => {
      configuredService = undefined;
      throw error;
    }));
}

export function createT3TerminalRoutes(dependencies: { service?: T3TerminalService } = {}) {
  const routes = new Hono();
  routes.post("/hosted/t3/terminal", async (c) => {
    const denied = requireCompadreApiKey(c);
    if (denied) return denied;
    const parsed = terminalRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid terminal request" }, 400);
    const service = dependencies.service ?? (await getConfiguredTerminalService());
    if (!service) return c.json({ error: "Worker terminals are unavailable" }, 503);
    try {
      const connection = await service.connect(parsed.data);
      const abort = new AbortController();
      const signal = AbortSignal.any([c.req.raw.signal, abort.signal]);
      const iterator = service.execute(parsed.data, connection, signal)[Symbol.asyncIterator]();
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const item = await iterator.next();
              if (item.done) {
                controller.close();
                return;
              }
              controller.enqueue(encoder.encode(JSON.stringify({ value: item.value }) + "\n"));
            } catch {
              controller.enqueue(
                encoder.encode(
                  JSON.stringify({
                    error: "Terminal disconnected. Reopen the terminal to connect again.",
                  }) + "\n",
                ),
              );
              controller.close();
            }
          },
          async cancel() {
            abort.abort();
            await iterator.return(undefined);
          },
        }),
        {
          headers: {
            "content-type": "application/x-ndjson",
            "cache-control": "no-store",
            "x-accel-buffering": "no",
          },
        },
      );
    } catch (error) {
      if (error instanceof TerminalAccessError)
        return c.json({ error: error.message }, error.status as 404 | 409 | 503);
      return c.json({ error: "Could not connect to the workspace" }, 503);
    }
  });
  return routes;
}
