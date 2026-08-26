export interface CompadreMcpBridge {
  readonly endpoint: string;
  readonly authorizationHeader: string;
}

export interface NativeMcpSession {
  readonly endpoint: string;
  readonly authorizationHeader: string;
}

export interface CodexMcpLaunchConfig {
  readonly environment: Record<string, string>;
  readonly appServerArgs: ReadonlyArray<string>;
}

const COMPADRE_MCP_SERVER_NAME = "compadre";
const COMPADRE_MCP_TOKEN_ENV = "COMPADRE_MCP_BEARER_TOKEN";

export function readCompadreMcpBridge(
  environment: NodeJS.ProcessEnv,
): CompadreMcpBridge | undefined {
  const endpoint = environment.COMPADRE_MCP_URL?.trim();
  const token = environment.COMPADRE_MCP_BEARER_TOKEN?.trim();
  if (!endpoint && !token) return undefined;
  if (!endpoint || !token) {
    throw new Error("COMPADRE_MCP_URL and COMPADRE_MCP_BEARER_TOKEN must be configured together.");
  }
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("COMPADRE_MCP_URL must use HTTP or HTTPS.");
  }
  return {
    endpoint: parsed.toString(),
    authorizationHeader: `Bearer ${token}`,
  };
}

export function buildClaudeMcpServers(
  nativeSession: NativeMcpSession | undefined,
  compadreBridge: CompadreMcpBridge | undefined,
) {
  const servers = {
    ...(nativeSession
      ? {
          "t3-code": {
            type: "http" as const,
            url: nativeSession.endpoint,
            headers: { Authorization: nativeSession.authorizationHeader },
          },
        }
      : {}),
    ...(compadreBridge
      ? {
          [COMPADRE_MCP_SERVER_NAME]: {
            type: "http" as const,
            url: compadreBridge.endpoint,
            headers: { Authorization: compadreBridge.authorizationHeader },
          },
        }
      : {}),
  };
  return Object.keys(servers).length > 0 ? servers : undefined;
}

export function buildCodexMcpLaunchConfig(
  nativeSession: NativeMcpSession | undefined,
  compadreBridge: CompadreMcpBridge | undefined,
): CodexMcpLaunchConfig | undefined {
  const environment: Record<string, string> = {};
  const appServerArgs: string[] = [];
  if (nativeSession) {
    environment.T3_MCP_BEARER_TOKEN = nativeSession.authorizationHeader.replace(/^Bearer\s+/, "");
    appServerArgs.push(
      "-c",
      `mcp_servers.t3-code.url=${nativeSession.endpoint}`,
      "-c",
      'mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"',
    );
  }
  if (compadreBridge) {
    environment[COMPADRE_MCP_TOKEN_ENV] = compadreBridge.authorizationHeader.replace(
      /^Bearer\s+/,
      "",
    );
    appServerArgs.push(
      "-c",
      `mcp_servers.${COMPADRE_MCP_SERVER_NAME}.url=${compadreBridge.endpoint}`,
      "-c",
      `mcp_servers.${COMPADRE_MCP_SERVER_NAME}.bearer_token_env_var="${COMPADRE_MCP_TOKEN_ENV}"`,
    );
  }
  return appServerArgs.length > 0 ? { environment, appServerArgs } : undefined;
}
