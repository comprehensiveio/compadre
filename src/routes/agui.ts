import {
  chatParamsFromRequestBody,
  toServerSentEventsResponse,
} from "@tanstack/ai";
import { Hono } from "hono";
import { runAguiChat } from "../tanstack/runtime.js";
import { isAgentProvider } from "../tanstack/protocol.js";

export const aguiRoutes = new Hono();

function isEnabled(): boolean {
  return process.env.COMPADRE_TANSTACK_AI_ENABLED === "true";
}

aguiRoutes.post("/ag-ui", async (c) => {
  if (!isEnabled()) return c.notFound();

  const apiKey = process.env.COMPADRE_API_KEY;
  if (!apiKey) {
    return c.json(
      { error: "COMPADRE_API_KEY is required when the AG-UI spike is enabled" },
      503
    );
  }
  if (c.req.header("Authorization") !== `Bearer ${apiKey}`) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  let params;
  try {
    params = await chatParamsFromRequestBody(body);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[ag-ui] rejected invalid protocol request: ${detail}`);
    return c.json({ error: "invalid AG-UI body" }, 400);
  }

  const requestedProvider = params.forwardedProps.provider;
  if (requestedProvider !== undefined && !isAgentProvider(requestedProvider)) {
    return c.json(
      { error: "forwardedProps.provider must be 'claude-code' or 'codex'" },
      400
    );
  }

  const stream = await runAguiChat(params, c.req.raw.signal);
  return toServerSentEventsResponse(stream);
});
