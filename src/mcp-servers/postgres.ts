/** Standalone read-only PostgreSQL MCP server. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pg from "pg";
import { z } from "zod";

const databaseUrl = process.env.READONLY_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("READONLY_DATABASE_URL environment variable must be set.");
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 2,
  options: "-c default_transaction_read_only=on -c statement_timeout=30000",
});

const server = new McpServer({ name: "postgres", version: "1.0.0" });

server.tool(
  "query",
  "Run a read-only SQL query against the Comprehensive PostgreSQL database.",
  { sql: z.string().trim().min(1).describe("The SQL query to execute") },
  async ({ sql }) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      const result = await client.query(sql);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { rows: result.rows, rowCount: result.rowCount },
              null,
              2,
            ),
          },
        ],
      };
    } finally {
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    }
  },
);

const shutdown = async () => {
  await pool.end();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await server.connect(new StdioServerTransport());
