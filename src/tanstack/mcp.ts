import { createMCPClient, type MCPClient } from "@tanstack/ai-mcp";
import type { AnyServerTool } from "@tanstack/ai";
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

/**
 * Resolve host-side MCP clients into ordinary server tools before the coding
 * adapter starts. Coding harness adapters bridge their `tools` input into the
 * sandbox; making discovery explicit here avoids relying on a later implicit
 * MCP-to-tools handoff at that process boundary.
 */
export async function discoverHarnessMcpTools(
  clients: ReadonlyArray<MCPClient>,
): Promise<AnyServerTool[]> {
  const groups = await Promise.all(clients.map((client) => client.tools()));
  const tools = groups.flat() as AnyServerTool[];
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error(`Duplicate MCP tool name: ${tool.name}`);
    }
    names.add(tool.name);
  }
  return tools;
}
