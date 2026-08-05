import {
  chatParamsFromRequestBody,
  toServerSentEventsResponse,
} from "@tanstack/ai";
import { Hono } from "hono";
import { runAguiChat } from "../tanstack/runtime.js";
import {
  isAgentProfile,
  isAgentProvider,
} from "../tanstack/protocol.js";
import { requireCompadreApiKey } from "./auth.js";

export const aguiRoutes = new Hono();

function isEnabled(): boolean {
  return process.env.COMPADRE_TANSTACK_AI_ENABLED === "true";
}

aguiRoutes.post("/ag-ui", async (c) => {
  if (!isEnabled()) return c.notFound();

  const authError = requireCompadreApiKey(c);
  if (authError) return authError;

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

  const requestedProfile = params.forwardedProps.profile;
  if (requestedProfile !== undefined && !isAgentProfile(requestedProfile)) {
    return c.json(
      {
        error:
          "forwardedProps.profile must be 'claude-code', 'codex', or 'fable'",
      },
      400,
    );
  }

  const stream = await runAguiChat(params, c.req.raw.signal);
  return toServerSentEventsResponse(stream);
});
