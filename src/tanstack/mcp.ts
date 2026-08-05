import { createMCPClient, type MCPClient } from "@tanstack/ai-mcp";
import { stdioTransport } from "@tanstack/ai-mcp/stdio";
import { buildMcpServers } from "../mcp.js";

export function mcpClientIdentity(name: string): {
  name: string;
  prefix: string;
} {
  return {
    name: `compadre-${name}`,
    prefix: name.replaceAll("-", "_"),
  };
}

/**
 * Convert Compadre's shared MCP configuration into host-side TanStack clients.
 * TanStack exposes the same tool inventory to either coding harness, keeping
 * integration configuration out of provider-specific branches.
 */
export async function buildTanStackMcpClients(): Promise<MCPClient[]> {
  const servers = await buildMcpServers();
  const clients = await Promise.all(
    Object.entries(servers).map(async ([name, config]) => {
      try {
        if ("command" in config) {
          return await createMCPClient({
            ...mcpClientIdentity(name),
            transport: stdioTransport({
              command: config.command,
              args: config.args,
              env: config.env,
              cwd: config.cwd,
            }),
          });
        }
        return await createMCPClient({
          ...mcpClientIdentity(name),
          transport: {
            type: config.type,
            url: config.url,
            headers: config.headers,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[tanstack-ai] MCP ${name} unavailable: ${message}`);
        return null;
      }
    })
  );

  return clients.filter((client): client is MCPClient => client !== null);
}
