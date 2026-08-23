import { randomBytes, randomUUID } from "node:crypto";
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

const MAX_BRIDGE_REQUEST_BYTES = 1024 * 1024;

interface ActiveRelayToolBridge {
  core: ToolBridgeCore;
  token: string;
}

const activeBridges = new Map<string, ActiveRelayToolBridge>();

function configuredPublicUrl(environment: NodeJS.ProcessEnv): URL {
  const raw = environment.COMPADRE_PUBLIC_URL?.trim();
  if (!raw) {
    throw new Error(
      "COMPADRE_PUBLIC_URL is required for the Daytona host-tool bridge",
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
      return {
        name: BRIDGED_MCP_SERVER_NAME,
        url: new URL(
          `/internal/tanstack-tool-bridge/${encodeURIComponent(bridgeId)}`,
          publicUrl,
        ).toString(),
        token,
        close: async () => {
          activeBridges.delete(bridgeId);
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
    return { status: 401, body: { error: "unauthorized" } };
  }
  const contentLength = Number(input.contentLength);
  if (Number.isFinite(contentLength) && contentLength > MAX_BRIDGE_REQUEST_BYTES) {
    return { status: 413, body: { error: "request too large" } };
  }
  if (input.body === undefined) {
    return { status: 400, body: { error: "invalid JSON body" } };
  }
  return {
    status: 200,
    body: await handleBridgeJsonRpc(bridge.core, input.body),
  };
}
