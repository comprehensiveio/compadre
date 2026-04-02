/**
 * Standalone stdio MCP server exposing Vitally tools (read & write).
 *
 * Read tools: list_accounts, get_account, get_health_scores, list_users, get_user,
 *             list_conversations, get_conversation, list_notes, get_note,
 *             list_note_categories, list_tasks, get_task, list_task_categories,
 *             list_nps_responses, list_projects, get_project, list_project_templates,
 *             list_project_categories
 *
 * Write tools: create_note, create_task, update_account
 *
 * Expects VITALLY_API_KEY in env.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_KEY = process.env.VITALLY_API_KEY;
if (!API_KEY) {
  throw new Error("VITALLY_API_KEY environment variable must be set.");
}

const BASE_URL = "https://comprehensive.rest.vitally.io";

const AUTH_HEADER = `Basic ${Buffer.from(`${API_KEY}:`).toString("base64")}`;

async function vitallyGet(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<unknown> {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
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

async function vitallyPost(path: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: AUTH_HEADER,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vitally API ${res.status}: ${text}`);
  }

  return res.json();
}

async function vitallyPut(path: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "PUT",
    headers: {
      Authorization: AUTH_HEADER,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vitally API ${res.status}: ${text}`);
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
      limit,
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
      limit,
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
      limit,
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
      limit,
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
      limit,
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
      limit,
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
      limit,
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
      limit,
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
      archived,
      source,
      limit,
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
      archived,
      source,
      limit,
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
      archived,
      source,
      limit,
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
      limit,
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
      archived,
      source,
      limit,
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
      archived,
      source,
      limit,
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
      archived,
      source,
      limit,
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
      limit,
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
      limit,
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
      limit,
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
      limit,
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
      archived,
      limit,
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
      limit,
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
      limit,
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
      limit,
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
      limit,
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
      limit,
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
      limit,
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

// ─── Write: Notes ───────────────────────────────────────────────────────

server.tool(
  "create_note",
  "Create a note on a Vitally account. Use this to log churn feedback, meeting summaries, or any account-level context.",
  {
    accountId: z.string().describe("Vitally account ID to attach the note to"),
    subject: z.string().describe("Note subject/title"),
    note: z.string().describe("Note body content (HTML supported)"),
    noteDate: z.string().optional().describe("Timestamp for the note in ISO 8601 format (e.g. 2026-04-01T14:30:00Z). Defaults to now if omitted."),
    categoryId: z.string().optional().describe("Note category ID (use list_note_categories to find available categories)"),
    tags: z.array(z.string()).optional().describe("Array of string tags to associate with the note"),
    authorId: z.string().optional().describe("Vitally admin ID to attribute the note to (use list_admins to find IDs)"),
    externalId: z.string().optional().describe("Optional external ID for deduplication"),
  },
  async ({ accountId, subject, note, noteDate, categoryId, tags, authorId, externalId }) => {
    const body: Record<string, unknown> = {
      accountId,
      subject,
      note,
      noteDate: noteDate ?? new Date().toISOString(),
    };
    if (categoryId) body.categoryId = categoryId;
    if (tags) body.tags = tags;
    if (authorId) body.authorId = authorId;
    if (externalId) body.externalId = externalId;
    const data = await vitallyPost("/resources/notes", body);
    return jsonResult(data);
  },
);

// ─── Write: Tasks ───────────────────────────────────────────────────────

server.tool(
  "create_task",
  "Create a task on a Vitally account. Use this to track follow-ups, action items, or account-level to-dos.",
  {
    accountId: z.string().describe("Vitally account ID to attach the task to"),
    subject: z.string().describe("Task subject/title"),
    description: z.string().optional().describe("Task description (HTML supported)"),
    dueDate: z.string().optional().describe("Due date in ISO 8601 format (e.g. 2026-04-15)"),
    assignedToId: z.string().optional().describe("Admin ID to assign the task to (use list_admins to find IDs)"),
    categoryId: z.string().optional().describe("Task category ID (use list_task_categories to find available categories)"),
    externalId: z.string().optional().describe("Optional external ID for deduplication"),
  },
  async ({ accountId, subject, description, dueDate, assignedToId, categoryId, externalId }) => {
    const body: Record<string, unknown> = {
      accountId,
      subject,
    };
    if (description) body.description = description;
    if (dueDate) body.dueDate = dueDate;
    if (assignedToId) body.assignedToId = assignedToId;
    if (categoryId) body.categoryId = categoryId;
    if (externalId) body.externalId = externalId;
    const data = await vitallyPost("/resources/tasks", body);
    return jsonResult(data);
  },
);

// ─── Write: Accounts ────────────────────────────────────────────────────

server.tool(
  "update_account",
  "Update a Vitally account's traits or custom fields. Use this to set churn reasons, update custom properties, etc.",
  {
    id: z.string().describe("Vitally account ID or externalId"),
    traits: z
      .record(z.string(), z.unknown())
      .describe("Key-value map of traits/custom fields to set on the account (e.g. { \"churn-reason\": \"consolidating tool stack\" })"),
  },
  async ({ id, traits }) => {
    const data = await vitallyPut(`/resources/accounts/${id}`, { traits });
    return jsonResult(data);
  },
);

// ─── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
