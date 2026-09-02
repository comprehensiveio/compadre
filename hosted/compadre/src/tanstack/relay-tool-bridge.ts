import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { defineChatMiddleware } from "@tanstack/ai";
import {
  BRIDGED_MCP_SERVER_NAME,
  createToolBridgeCore,
  handleBridgeJsonRpc,
  provideToolBridgeProvisioner,
  timingSafeBearerEqual,
  type ToolBridgeCore,
  type ToolBridgeProvisioner,
} from "@tanstack/ai-sandbox";
import { buildTanStackMcpClients, discoverHarnessMcpTools } from "./mcp.js";

export const MAX_BRIDGE_REQUEST_BYTES = 1024 * 1024;

export function configuredEnvironmentBridgeToken(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  return (
    environment.COMPADRE_T3_MCP_BEARER_TOKEN?.trim() ||
    environment.COMPADRE_API_KEY?.trim()
  );
}

export function scopedEnvironmentBridgeToken(
  token: string,
  destination: { channelId: string; threadTs: string },
): string {
  return createHmac("sha256", token)
    .update("compadre:t3-mcp:slack-destination:v1\0")
    .update(destination.channelId)
    .update("\0")
    .update(destination.threadTs)
    .digest("base64url");
}

interface ActiveRelayToolBridge {
  core: ToolBridgeCore;
  token: string;
}

const activeBridges = new Map<string, ActiveRelayToolBridge>();
let environmentBridgeCore: Promise<ToolBridgeCore> | undefined;

async function buildEnvironmentBridgeCore(): Promise<ToolBridgeCore> {
  const clients = await buildTanStackMcpClients();
  try {
    const tools = await discoverHarnessMcpTools(clients);
    console.log("[tool-bridge] environment bridge ready", {
      toolCount: tools.length,
    });
    // The clients deliberately remain open for the gateway process lifetime.
    // HTTP MCP requests are stateless, while stdio MCP tools need their child
    // processes to remain available between native T3 turns.
    return createToolBridgeCore(tools);
  } catch (error) {
    await Promise.allSettled(clients.map((client) => client.close()));
    throw error;
  }
}

export function getEnvironmentToolBridgeCore(): Promise<ToolBridgeCore> {
  if (environmentBridgeCore) return environmentBridgeCore;
  const pending = buildEnvironmentBridgeCore();
  environmentBridgeCore = pending;
  void pending.catch(() => {
    if (environmentBridgeCore === pending) environmentBridgeCore = undefined;
  });
  return pending;
}

function configuredPublicUrl(environment: NodeJS.ProcessEnv): URL {
  const raw = environment.COMPADRE_PUBLIC_URL?.trim();
  if (!raw) {
    throw new Error(
      "COMPADRE_PUBLIC_URL is required for the sandbox host-tool bridge",
    );
  }
  const url = new URL(raw);
  if (url.protocol !== "https:" && environment.NODE_ENV !== "test") {
    throw new Error("COMPADRE_PUBLIC_URL must use HTTPS");
  }
  return url;
}

export function createRelayToolBridgeProvisioner(
  environment: NodeJS.ProcessEnv = process.env,
): ToolBridgeProvisioner {
  return {
    async provision(tools, options) {
      const publicUrl = configuredPublicUrl(environment);
      const bridgeId = randomUUID();
      const token = randomBytes(24).toString("hex");
      const { provider: _provider, ...coreOptions } = options;
      activeBridges.set(bridgeId, {
        token,
        core: createToolBridgeCore(tools, coreOptions),
      });
      console.log("[tool-bridge] registered", {
        bridgeId,
        provider: options.provider,
        toolCount: tools.length,
      });
      return {
        name: BRIDGED_MCP_SERVER_NAME,
        url: new URL(
          `/internal/tanstack-tool-bridge/${encodeURIComponent(bridgeId)}`,
          publicUrl,
        ).toString(),
        token,
        close: async () => {
          activeBridges.delete(bridgeId);
          console.log("[tool-bridge] closed", { bridgeId });
        },
      };
    },
  };
}

export const withRelayToolBridge = defineChatMiddleware({
  name: "compadre-relay-tool-bridge",
  setup(context) {
    provideToolBridgeProvisioner(
      context,
      createRelayToolBridgeProvisioner(),
    );
  },
});

export async function dispatchRelayToolBridgeRequest(input: {
  bridgeId: string;
  authorization?: string;
  contentLength?: string;
  body: unknown;
}): Promise<
  | { status: 200; body: unknown | null }
  | { status: 400 | 401 | 404 | 413; body: { error: string } }
> {
  const bridge = activeBridges.get(input.bridgeId);
  if (!bridge) return { status: 404, body: { error: "not found" } };
  if (!timingSafeBearerEqual(input.authorization, bridge.token)) {
    console.warn("[tool-bridge] request rejected", {
      bridgeId: input.bridgeId,
      status: 401,
    });
    return { status: 401, body: { error: "unauthorized" } };
  }
  const contentLength = Number(input.contentLength);
  if (Number.isFinite(contentLength) && contentLength > MAX_BRIDGE_REQUEST_BYTES) {
    return { status: 413, body: { error: "request too large" } };
  }
  if (input.body === undefined) {
    return { status: 400, body: { error: "invalid JSON body" } };
  }
  console.log("[tool-bridge] request accepted", {
    bridgeId: input.bridgeId,
    status: 200,
  });
  return {
    status: 200,
    body: await handleBridgeJsonRpc(bridge.core, input.body),
  };
}

export async function dispatchEnvironmentToolBridgeRequest(input: {
  authorization?: string;
  contentLength?: string;
  body: unknown;
  environment?: NodeJS.ProcessEnv;
  core?: ToolBridgeCore;
  blockedSlackDestination?: {
    channelId?: string;
    threadTs?: string;
  };
}): Promise<
  | { status: 200; body: unknown | null }
  | { status: 400 | 401 | 404 | 413; body: { error: string } }
> {
  const rootToken = configuredEnvironmentBridgeToken(
    input.environment ?? process.env,
  );
  if (!rootToken) return { status: 404, body: { error: "not found" } };
  const blocked = input.blockedSlackDestination;
  const token =
    blocked?.channelId && blocked.threadTs
      ? scopedEnvironmentBridgeToken(rootToken, {
          channelId: blocked.channelId,
          threadTs: blocked.threadTs,
        })
      : rootToken;
  if (!timingSafeBearerEqual(input.authorization, token)) {
    console.warn("[tool-bridge] environment request rejected", {
      status: 401,
    });
    return { status: 401, body: { error: "unauthorized" } };
  }
  const contentLength = Number(input.contentLength);
  if (Number.isFinite(contentLength) && contentLength > MAX_BRIDGE_REQUEST_BYTES) {
    return { status: 413, body: { error: "request too large" } };
  }
  if (input.body === undefined) {
    return { status: 400, body: { error: "invalid JSON body" } };
  }
  const request =
    input.body && typeof input.body === "object" && !Array.isArray(input.body)
      ? (input.body as Record<string, unknown>)
      : undefined;
  const params =
    request?.params &&
    typeof request.params === "object" &&
    !Array.isArray(request.params)
      ? (request.params as Record<string, unknown>)
      : undefined;
  const args =
    params?.arguments &&
    typeof params.arguments === "object" &&
    !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : undefined;
  if (
    request?.method === "tools/call" &&
    params?.name === "slack_reply_to_thread" &&
    blocked?.channelId &&
    blocked.threadTs &&
    args?.channel_id === blocked.channelId &&
    args.thread_ts === blocked.threadTs
  ) {
    return {
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [
            {
              type: "text",
              text: "Compadre owns final delivery for this Slack thread; return the final answer normally instead of posting it with a Slack tool.",
            },
          ],
          isError: true,
        },
      },
    };
  }
  const core = input.core ?? (await getEnvironmentToolBridgeCore());
  return {
    status: 200,
    body: await handleBridgeJsonRpc(core, input.body),
  };
}
