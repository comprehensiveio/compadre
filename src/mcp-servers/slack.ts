/**
 * Standalone stdio MCP server for Slack.
 *
 * Message tools accept standard Markdown and send it through Slack's
 * `markdown_text` field. File uploads use Slack's external upload flow.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SlackClient } from "../services/slack-client.js";
import { PullRequestWatchService } from "../services/pr-watch.js";

const botToken = process.env.SLACK_BOT_TOKEN;
const teamId = process.env.SLACK_TEAM_ID;
if (!botToken || !teamId) {
  throw new Error("SLACK_BOT_TOKEN and SLACK_TEAM_ID must be set");
}

const slack = new SlackClient({
  botToken,
  teamId,
  channelIds: process.env.SLACK_CHANNEL_IDS,
});
const server = new McpServer({ name: "slack", version: "2.0.0" });
let prWatchService: Promise<PullRequestWatchService> | undefined;

function getPullRequestWatchService(): Promise<PullRequestWatchService> {
  if (!prWatchService) {
    const initialization = (async () => {
      const connectionString = process.env.COMPADRE_DURABILITY_DATABASE_URL;
      if (!connectionString) {
        throw new Error(
          "COMPADRE_DURABILITY_DATABASE_URL is required to watch a PR deployment",
        );
      }
      const service = new PullRequestWatchService({
        connectionString,
        botToken: botToken!,
        teamId: teamId!,
      });
      await service.initialize();
      return service;
    })().catch((error) => {
      if (prWatchService === initialization) prWatchService = undefined;
      throw error;
    });
    prWatchService = initialization;
  }
  return prWatchService;
}

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

server.tool(
  "slack_list_channels",
  "List public or configured Slack channels with pagination",
  {
    limit: z.number().max(200).optional().default(100),
    cursor: z.string().optional(),
  },
  async ({ limit, cursor }) => jsonResult(await slack.listChannels(limit, cursor)),
);

server.tool(
  "slack_post_message",
  "Post a new Slack message. The text must be natural, standard Markdown; headings, tables, links, lists, block quotes, and fenced code blocks are supported.",
  {
    channel_id: z.string().describe("Channel ID to post to"),
    text: z.string().describe("Message formatted as standard Markdown"),
  },
  async ({ channel_id, text }) =>
    jsonResult(await slack.postMessage(channel_id, text)),
);

server.tool(
  "slack_reply_to_thread",
  "Reply in a Slack thread using natural, standard Markdown.",
  {
    channel_id: z.string().describe("Channel ID containing the thread"),
    thread_ts: z.string().describe("Root message timestamp"),
    text: z.string().describe("Reply formatted as standard Markdown"),
  },
  async ({ channel_id, thread_ts, text }) =>
    jsonResult(await slack.replyToThread(channel_id, thread_ts, text)),
);

server.tool(
  "watch_comp_pr_deployment",
  "Durably watch a comprehensiveio/comp pull request and notify the specified Slack thread after that PR is live on the primary CM production app service. Use only when the user asks for a future production notification. Resolve the exact PR first; this tool does not search for a PR.",
  {
    pr_number: z.number().int().positive().describe(
      "The resolved comprehensiveio/comp pull request number",
    ),
    channel_id: z.string().trim().min(1).describe(
      "The channel ID from the Reply to section of the Slack prompt",
    ),
    thread_ts: z.string().trim().min(1).describe(
      "The thread timestamp from the Reply to section of the Slack prompt",
    ),
  },
  async ({ pr_number, channel_id, thread_ts }) => {
    const watchService = await getPullRequestWatchService();
    const prUrl = `https://github.com/comprehensiveio/comp/pull/${pr_number}`;
    const result = await watchService.register(
      { prNumber: pr_number, prUrl },
      { teamId, channelId: channel_id, threadTs: thread_ts },
    );
    return jsonResult({
      ...result,
      pr_number,
      pr_url: prUrl,
      message: result.created
        ? `Watching PR #${pr_number} for production deployment.`
        : `PR #${pr_number} is already being watched in this thread.`,
    });
  },
);

server.tool(
  "slack_upload_file",
  "Upload a local file to a Slack channel or thread. Use for genuinely downloadable artifacts or content too large to present comfortably inline.",
  {
    channel_id: z.string().describe("Destination channel ID"),
    file_path: z.string().describe("Absolute path to the local file"),
    thread_ts: z.string().optional().describe("Root message timestamp"),
    title: z.string().optional().describe("Display title; defaults to filename"),
  },
  async ({ channel_id, file_path, thread_ts, title }) =>
    jsonResult(
      await slack.uploadFile({
        channel: channel_id,
        filePath: file_path,
        threadTs: thread_ts,
        title,
      }),
    ),
);

server.tool(
  "slack_add_reaction",
  "Add an emoji reaction to a Slack message",
  {
    channel_id: z.string(),
    timestamp: z.string(),
    reaction: z.string().describe("Emoji name without colons"),
  },
  async ({ channel_id, timestamp, reaction }) =>
    jsonResult(await slack.addReaction(channel_id, timestamp, reaction)),
);

server.tool(
  "slack_get_channel_history",
  "Get recent messages from a Slack channel",
  {
    channel_id: z.string(),
    limit: z.number().optional().default(10),
  },
  async ({ channel_id, limit }) =>
    jsonResult(await slack.getChannelHistory(channel_id, limit)),
);

server.tool(
  "slack_get_thread_replies",
  "Get all replies in a Slack message thread",
  {
    channel_id: z.string(),
    thread_ts: z.string(),
  },
  async ({ channel_id, thread_ts }) =>
    jsonResult(await slack.getThreadReplies(channel_id, thread_ts)),
);

server.tool(
  "slack_get_users",
  "Get Slack users with pagination",
  {
    cursor: z.string().optional(),
    limit: z.number().max(200).optional().default(100),
  },
  async ({ cursor, limit }) => jsonResult(await slack.getUsers(limit, cursor)),
);

server.tool(
  "slack_get_user_profile",
  "Get a Slack user's detailed profile",
  { user_id: z.string() },
  async ({ user_id }) => jsonResult(await slack.getUserProfile(user_id)),
);

await server.connect(new StdioServerTransport());
