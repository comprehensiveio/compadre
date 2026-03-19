/**
 * Standalone stdio MCP server exposing read-only Vitally tools.
 *
 * Tools: list_accounts, get_account, get_health_scores, list_users, get_user,
 *        list_conversations, get_conversation, list_notes, get_note,
 *        list_note_categories, list_tasks, get_task, list_task_categories,
 *        list_nps_responses, list_projects, get_project, list_project_templates,
 *        list_project_categories
 *
 * Expects VITALLY_API_KEY in env.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_KEY = process.env.VITALLY_API_KEY!;

const BASE_URL = "https://comprehensive.rest.vitally.io";

const AUTH_HEADER = `Basic ${Buffer.from(`${API_KEY}:`).toString("base64")}`;

async function vitallyGet(path: string, params?: Record<string, string | undefined>): Promise<unknown> {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: AUTH_HEADER },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Vitally API ${res.status}: ${body}`);
  }

  return res.json();
}

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// Reusable pagination params
const paginationParams = {
  limit: z.number().max(100).optional().describe("Max items to return (max 100)"),
  from: z.string().optional().describe("Cursor from previous response for pagination"),
};

const server = new McpServer({
  name: "vitally",
  version: "1.0.0",
});

// ─── Accounts ────────────────────────────────────────────────────────────────

server.tool(
  "list_accounts",
  "List Vitally accounts with optional status filter. Returns paginated results ordered by updatedAt.",
  {
    status: z
      .enum(["active", "churned", "activeOrChurned"])
      .optional()
      .describe("Filter by account status (defaults to active)"),
    ...paginationParams,
  },
  async ({ status, limit, from }) => {
    const data = await vitallyGet("/resources/accounts", {
      status,
      limit: limit?.toString(),
      from,
    });
    return jsonResult(data);
  },
);

server.tool(
  "list_organization_accounts",
  "List accounts belonging to a specific organization.",
  {
    organizationId: z.string().describe("Vitally organization ID"),
    ...paginationParams,
  },
  async ({ organizationId, limit, from }) => {
    const data = await vitallyGet(`/resources/organizations/${organizationId}/accounts`, {
      limit: limit?.toString(),
      from,
    });
    return jsonResult(data);
  },
);

server.tool(
  "get_account",
  "Get a single Vitally account by ID or externalId.",
  {
    id: z.string().describe("Vitally account ID or externalId"),
  },
  async ({ id }) => {
    const data = await vitallyGet(`/resources/accounts/${id}`);
    return jsonResult(data);
  },
);

server.tool(
  "get_health_scores",
  "Get the health score breakdown for a Vitally account.",
  {
    id: z.string().describe("Vitally account ID or externalId"),
  },
  async ({ id }) => {
    const data = await vitallyGet(`/resources/accounts/${id}/healthScores`);
    return jsonResult(data);
  },
);

// ─── Users ───────────────────────────────────────────────────────────────────

server.tool(
  "list_users",
  "List all Vitally users. Returns paginated results ordered by updatedAt.",
  {
    ...paginationParams,
  },
  async ({ limit, from }) => {
    const data = await vitallyGet("/resources/users", {
      limit: limit?.toString(),
      from,
    });
    return jsonResult(data);
  },
);

server.tool(
  "list_account_users",
  "List users belonging to a specific account.",
  {
    accountId: z.string().describe("Vitally account ID"),
    ...paginationParams,
  },
  async ({ accountId, limit, from }) => {
    const data = await vitallyGet(`/resources/accounts/${accountId}/users`, {
      limit: limit?.toString(),
      from,
    });
    return jsonResult(data);
  },
);

server.tool(
  "list_organization_users",
  "List users belonging to a specific organization.",
  {
    organizationId: z.string().describe("Vitally organization ID"),
    ...paginationParams,
  },
  async ({ organizationId, limit, from }) => {
    const data = await vitallyGet(`/resources/organizations/${organizationId}/users`, {
      limit: limit?.toString(),
      from,
    });
    return jsonResult(data);
  },
);

server.tool(
  "get_user",
  "Get a single Vitally user by ID or externalId.",
  {
    id: z.string().describe("Vitally user ID or externalId"),
  },
  async ({ id }) => {
    const data = await vitallyGet(`/resources/users/${id}`);
    return jsonResult(data);
  },
);

// ─── Conversations ───────────────────────────────────────────────────────────

server.tool(
  "list_conversations",
  "List all Vitally conversations. Note: messages are not included in list responses — use get_conversation for full messages.",
  {
    ...paginationParams,
  },
  async ({ limit, from }) => {
    const data = await vitallyGet("/resources/conversations", {
      limit: limit?.toString(),
      from,
    });
    return jsonResult(data);
  },
);

server.tool(
  "list_account_conversations",
  "List conversations for a specific account. Messages not included — use get_conversation for full messages.",
  {
    accountId: z.string().describe("Vitally account ID"),
    ...paginationParams,
  },
  async ({ accountId, limit, from }) => {
    const data = await vitallyGet(`/resources/accounts/${accountId}/conversations`, {
      limit: limit?.toString(),
      from,
    });
    return jsonResult(data);
  },
);

server.tool(
  "list_organization_conversations",
  "List conversations for a specific organization. Messages not included — use get_conversation for full messages.",
  {
    organizationId: z.string().describe("Vitally organization ID"),
    ...paginationParams,
  },
  async ({ organizationId, limit, from }) => {
    const data = await vitallyGet(`/resources/organizations/${organizationId}/conversations`, {
      limit: limit?.toString(),
      from,
    });
    return jsonResult(data);
  },
);

server.tool(
  "get_conversation",
  "Get a single Vitally conversation by ID, including all messages.",
  {
    id: z.string().describe("Vitally conversation ID or externalId"),
  },
  async ({ id }) => {
    const data = await vitallyGet(`/resources/conversations/${id}`);
    return jsonResult(data);
  },
);

// ─── Notes ───────────────────────────────────────────────────────────────────

server.tool(
  "list_notes",
  "List all Vitally notes. Returns paginated results ordered by updatedAt.",
  {
    archived: z.boolean().optional().describe("If true, return archived/deleted notes"),
    source: z.string().optional().describe("Filter by integration source name"),
    ...paginationParams,
  },
  async ({ archived, source, limit, from }) => {
    const data = await vitallyGet("/resources/notes", {
      archived: archived?.toString(),
      source,
      limit: limit?.toString(),
      from,
    });
    return jsonResult(data);
  },
);

server.tool(
  "list_account_notes",
  "List notes for a specific account.",
  {
    accountId: z.string().describe("Vitally account ID"),
    archived: z.boolean().optional().describe("If true, return archived/deleted notes"),
    source: z.string().optional().describe("Filter by integration source name"),
    ...paginationParams,
  },
  async ({ accountId, archived, source, limit, from }) => {
    const data = await vitallyGet(`/resources/accounts/${accountId}/notes`, {
      archived: archived?.toString(),
      source,
      limit: limit?.toString(),
      from,
    });
    return jsonResult(data);
  },
);

server.tool(
  "list_organization_notes",
  "List notes for a specific organization.",
  {
    organizationId: z.string().describe("Vitally organization ID"),
    archived: z.boolean().optional().describe("If true, return archived/deleted notes"),
    source: z.string().optional().describe("Filter by integration source name"),
    ...paginationParams,
  },
  async ({ organizationId, archived, source, limit, from }) => {
    const data = await vitallyGet(`/resources/organizations/${organizationId}/notes`, {
      archived: archived?.toString(),
      source,
      limit: limit?.toString(),
      from,
    });
    return jsonResult(data);
  },
);

server.tool(
  "get_note",
  "Get a single Vitally note by ID or externalId. When using externalId, provide the source parameter.",
  {
    id: z.string().describe("Vitally note ID or externalId"),
    source: z.string().optional().describe("Integration source name (required when looking up by externalId)"),
  },
  async ({ id, source }) => {
    const data = await vitallyGet(`/resources/notes/${id}`, { source });
    return jsonResult(data);
  },
);

server.tool(
  "list_note_categories",
  "List all note categories configured in Vitally.",
  {
    ...paginationParams,
  },
  async ({ limit, from }) => {
    const data = await vitallyGet("/resources/noteCategories", {
      limit: limit?.toString(),
      from,
    });
    return jsonResult(data);
  },
);

// ─── Tasks ───────────────────────────────────────────────────────────────────

server.tool(
  "list_tasks",
  "List all Vitally tasks. Returns paginated results ordered by updatedAt.",
  {
    archived: z.boolean().optional().describe("If true, return archived/deleted tasks"),
    source: z.string().optional().describe("Filter by integration source name"),
    ...paginationParams,
  },
  async ({ archived, source, limit, from }) => {
    const data = await vitallyGet("/resources/tasks", {
      archived: archived?.toString(),
      source,
      limit: limit?.toString(),
      from,
    });
    return jsonResult(data);
  },
);

server.tool(
  "list_account_tasks",
  "List tasks for a specific account.",
  {
    accountId: z.string().describe("Vitally account ID"),
    archived: z.boolean().optional().describe("If true, return archived/deleted tasks"),
    source: z.string().optional().describe("Filter by integration source name"),
    ...paginationParams,
  },
  async ({ accountId, archived, source, limit, from }) => {
    const data = await vitallyGet(`/resources/accounts/${accountId}/tasks`, {
      archived: archived?.toString(),
      source,
      limit: limit?.toString(),
      from,
    });
    return jsonResult(data);
  },
);

server.tool(
  "list_organization_tasks",
  "List tasks for a specific organization.",
  {
    organizationId: z.string().describe("Vitally organization ID"),
    archived: z.boolean().optional().describe("If true, return archived/deleted tasks"),
    source: z.string().optional().describe("Filter by integration source name"),
    ...paginationParams,
  },
  async ({ organizationId, archived, source, limit, from }) => {
    const data = await vitallyGet(`/resources/organizations/${organizationId}/tasks`, {
      archived: archived?.toString(),
      source,
      limit: limit?.toString(),
      from,
    });
    return jsonResult(data);
  },
);

server.tool(
  "get_task",
  "Get a single Vitally task by ID or externalId. When using externalId, provide the source parameter.",
  {
    id: z.string().describe("Vitally task ID or externalId"),
    source: z.string().optional().describe("Integration source name (required when looking up by externalId)"),
  },
  async ({ id, source }) => {
    const data = await vitallyGet(`/resources/tasks/${id}`, { source });
    return jsonResult(data);
  },
);

server.tool(
  "list_task_categories",
  "List all task categories configured in Vitally.",
  {
    ...paginationParams,
  },
  async ({ limit, from }) => {
    const data = await vitallyGet("/resources/taskCategories", {
      limit: limit?.toString(),
      from,
    });
    return jsonResult(data);
  },
);

// ─── NPS Responses ───────────────────────────────────────────────────────────

server.tool(
  "list_nps_responses",
  "List all NPS responses. Returns paginated results ordered by updatedAt.",
  {
    target: z
      .enum(["accounts", "organization"])
      .optional()
      .describe("Filter by target type (defaults to accounts)"),
    ...paginationParams,
  },
  async ({ target, limit, from }) => {
    const data = await vitallyGet("/resources/npsResponses", {
      target,
      limit: limit?.toString(),
      from,
    });
    return jsonResult(data);
  },
);

server.tool(
  "list_account_nps_responses",
  "List NPS responses for a specific account.",
  {
    accountId: z.string().describe("Vitally account ID"),
    ...paginationParams,
  },
  async ({ accountId, limit, from }) => {
    const data = await vitallyGet(`/resources/accounts/${accountId}/npsResponses`, {
      limit: limit?.toString(),
      from,
    });
    return jsonResult(data);
  },
);

server.tool(
  "list_organization_nps_responses",
  "List NPS responses for a specific organization.",
  {
    organizationId: z.string().describe("Vitally organization ID"),
    ...paginationParams,
  },
  async ({ organizationId, limit, from }) => {
    const data = await vitallyGet(`/resources/organizations/${organizationId}/npsResponses`, {
      limit: limit?.toString(),
      from,
    });
    return jsonResult(data);
  },
);

server.tool(
  "get_nps_response",
  "Get a single NPS response by ID.",
  {
    id: z.string().describe("Vitally NPS response ID"),
  },
  async ({ id }) => {
    const data = await vitallyGet(`/resources/npsResponses/${id}`);
    return jsonResult(data);
  },
);

// ─── Projects ────────────────────────────────────────────────────────────────

server.tool(
  "list_projects",
  "List all Vitally projects. Returns paginated results ordered by updatedAt.",
  {
    archived: z.boolean().optional().describe("If true, return archived/deleted projects"),
    ...paginationParams,
  },
  async ({ archived, limit, from }) => {
    const data = await vitallyGet("/resources/projects", {
      archived: archived?.toString(),
      limit: limit?.toString(),
      from,
    });
    return jsonResult(data);
  },
);

server.tool(
  "list_account_projects",
  "List projects for a specific account.",
  {
    accountId: z.string().describe("Vitally account ID"),
    ...paginationParams,
  },
  async ({ accountId, limit, from }) => {
    const data = await vitallyGet(`/resources/accounts/${accountId}/projects`, {
      limit: limit?.toString(),
      from,
    });
    return jsonResult(data);
  },
);

server.tool(
  "list_organization_projects",
  "List projects for a specific organization.",
  {
    organizationId: z.string().describe("Vitally organization ID"),
    ...paginationParams,
  },
  async ({ organizationId, limit, from }) => {
    const data = await vitallyGet(`/resources/organizations/${organizationId}/projects`, {
      limit: limit?.toString(),
      from,
    });
    return jsonResult(data);
  },
);

server.tool(
  "get_project",
  "Get a single Vitally project by ID.",
  {
    id: z.string().describe("Vitally project ID"),
  },
  async ({ id }) => {
    const data = await vitallyGet(`/resources/projects/${id}`);
    return jsonResult(data);
  },
);

// ─── Project Templates & Categories ──────────────────────────────────────────

server.tool(
  "list_project_templates",
  "List all project templates configured in Vitally.",
  {
    categoryId: z.string().optional().describe("Filter by project category ID"),
    ...paginationParams,
  },
  async ({ categoryId, limit, from }) => {
    const data = await vitallyGet("/resources/projectTemplates", {
      categoryId,
      limit: limit?.toString(),
      from,
    });
    return jsonResult(data);
  },
);

server.tool(
  "list_project_categories",
  "List all project categories configured in Vitally.",
  {
    ...paginationParams,
  },
  async ({ limit, from }) => {
    const data = await vitallyGet("/resources/projectCategories", {
      limit: limit?.toString(),
      from,
    });
    return jsonResult(data);
  },
);

// ─── Admins ──────────────────────────────────────────────────────────────────

server.tool(
  "list_admins",
  "List all Vitally admins (team members). Useful for resolving CSM/owner IDs.",
  {
    ...paginationParams,
  },
  async ({ limit, from }) => {
    const data = await vitallyGet("/resources/admins", {
      limit: limit?.toString(),
      from,
    });
    return jsonResult(data);
  },
);

// ─── Organizations ───────────────────────────────────────────────────────────

server.tool(
  "list_organizations",
  "List all Vitally organizations. Returns paginated results ordered by updatedAt.",
  {
    ...paginationParams,
  },
  async ({ limit, from }) => {
    const data = await vitallyGet("/resources/organizations", {
      limit: limit?.toString(),
      from,
    });
    return jsonResult(data);
  },
);

server.tool(
  "get_organization",
  "Get a single Vitally organization by ID or externalId.",
  {
    id: z.string().describe("Vitally organization ID or externalId"),
  },
  async ({ id }) => {
    const data = await vitallyGet(`/resources/organizations/${id}`);
    return jsonResult(data);
  },
);

// ─── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
