import { createMCPClient, type MCPClient } from "@tanstack/ai-mcp";
import type { AnyServerTool } from "@tanstack/ai";
import { stdioTransport } from "@tanstack/ai-mcp/stdio";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { buildMcpServers } from "../mcp.js";

const mcpServerNames = new WeakMap<MCPClient, string>();

async function timedMcpPhase<T>(
  phase: "connect" | "discover",
  server: string,
  task: () => Promise<T>,
): Promise<T> {
  return trace.getTracer("compadre.runtime").startActiveSpan(
    `compadre.agent.mcp.${phase}`,
    {
      attributes: {
        "mcp.server.name": server,
        "compadre.phase": `mcp.${phase}`,
      },
    },
    async (span) => {
      const startedAt = Date.now();
      let outcome = "success";
      try {
        return await task();
      } catch (error) {
        outcome = "error";
        span.recordException(error instanceof Error ? error : String(error));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        const elapsedMs = Date.now() - startedAt;
        span.setAttributes({
          "compadre.outcome": outcome,
          "compadre.phase.duration_ms": elapsedMs,
        });
        span.end();
        console.log("[mcp-timing]", {
          traceId: span.spanContext().traceId,
          phase,
          server,
          outcome,
          elapsedMs,
        });
      }
    },
  );
}

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
        const client = await timedMcpPhase("connect", name, async () => {
          if ("command" in config) {
            return createMCPClient({
              ...mcpClientIdentity(name),
              transport: stdioTransport({
                command: config.command,
                args: config.args,
                env: config.env,
                cwd: config.cwd,
              }),
            });
          }
          return createMCPClient({
            ...mcpClientIdentity(name),
            transport: {
              type: config.type,
              url: config.url,
              headers: config.headers,
            },
          });
        });
        mcpServerNames.set(client, name);
        return client;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[tanstack-ai] MCP ${name} unavailable: ${message}`);
        return null;
      }
    }),
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
  const groups = await Promise.all(
    clients.map((client, index) => {
      const server =
        mcpServerNames.get(client) ||
        client.getInfo?.().prefix ||
        `client-${index + 1}`;
      return timedMcpPhase("discover", server, () => client.tools());
    }),
  );
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
