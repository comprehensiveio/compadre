/**
 * Standalone read-only PostgreSQL MCP server.
 *
 * This preserves the tool and resource contract of the retired upstream
 * server while using our current MCP SDK and keeping the database URL out of
 * the process command line.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import pg from "pg";

const databaseUrl = process.env.READONLY_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("READONLY_DATABASE_URL environment variable must be set.");
}

const resourceBaseUrl = new URL(databaseUrl);
resourceBaseUrl.protocol = "postgres:";
resourceBaseUrl.username = "";
resourceBaseUrl.password = "";

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 2,
  options: "-c default_transaction_read_only=on -c statement_timeout=30000",
});

const server = new Server(
  { name: "compadre-postgres", version: "1.0.0" },
  { capabilities: { resources: {}, tools: {} } },
);

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const result = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
  );
  return {
    resources: result.rows.map(({ table_name: tableName }) => ({
      uri: new URL(`${tableName}/schema`, resourceBaseUrl).href,
      mimeType: "application/json",
      name: `\"${tableName}\" database schema`,
    })),
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const resourceUrl = new URL(request.params.uri);
  const path = resourceUrl.pathname.split("/").filter(Boolean);
  const schema = path.pop();
  const tableName = path.pop();
  if (schema !== "schema" || !tableName) {
    throw new Error("Invalid PostgreSQL schema resource URI");
  }

  const result = await pool.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
    [tableName],
  );
  return {
    contents: [
      {
        uri: request.params.uri,
        mimeType: "application/json",
        text: JSON.stringify(result.rows, null, 2),
      },
    ],
  };
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "query",
      description: "Run a read-only SQL query",
      inputSchema: {
        type: "object",
        properties: { sql: { type: "string" } },
        required: ["sql"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "query") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }
  const sql = request.params.arguments?.sql;
  if (typeof sql !== "string" || sql.trim().length === 0) {
    throw new Error("query requires a non-empty sql string");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const result = await client.query(sql);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result.rows, null, 2) },
      ],
      isError: false,
    };
  } finally {
    try {
      await client.query("ROLLBACK");
    } catch (error) {
      console.warn("[postgres-mcp] could not roll back transaction", error);
    }
    client.release();
  }
});

const shutdown = async () => {
  await pool.end();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await server.connect(new StdioServerTransport());
