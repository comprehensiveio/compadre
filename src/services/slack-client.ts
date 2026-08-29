import fs from "fs/promises";
import path from "path";
import { truncateSlackMarkdown } from "./slack-markdown.js";

const SLACK_API = "https://slack.com/api";

type SlackResponse = Record<string, unknown> & {
  ok?: boolean;
  error?: string;
};

export interface DownloadedSlackFile {
  data: Uint8Array;
  name: string;
  mimetype: string;
}

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export interface SlackClientOptions {
  botToken: string;
  teamId: string;
  channelIds?: string;
  fetchImpl?: typeof fetch;
}

export class SlackClient {
  private readonly botToken: string;
  private readonly teamId: string;
  private readonly channelIds?: string;
  private readonly fetchImpl: typeof fetch;

  constructor({
    botToken,
    teamId,
    channelIds,
    fetchImpl = fetch,
  }: SlackClientOptions) {
    this.botToken = botToken;
    this.teamId = teamId;
    this.channelIds = channelIds;
    this.fetchImpl = fetchImpl;
  }

  async listChannels(limit = 100, cursor?: string): Promise<SlackResponse> {
    if (this.channelIds) {
      const channels: unknown[] = [];
      for (const channel of this.channelIds.split(",").map((id) => id.trim())) {
        if (!channel) continue;
        const data = await this.get("conversations.info", { channel });
        const channelInfo = data.channel as { is_archived?: boolean } | undefined;
        if (channelInfo && !channelInfo.is_archived) channels.push(channelInfo);
      }
      return {
        ok: true,
        channels,
        response_metadata: { next_cursor: "" },
      };
    }

    return this.get("conversations.list", {
      types: "public_channel",
      exclude_archived: "true",
      limit: String(Math.min(limit, 200)),
      team_id: this.teamId,
      cursor,
    });
  }

  async postMessage(channel: string, markdown: string): Promise<SlackResponse> {
    return this.post("chat.postMessage", {
      channel,
      markdown_text: truncateSlackMarkdown(markdown),
    });
  }

  async replyToThread(
    channel: string,
    threadTs: string,
    markdown: string,
    clientMsgId?: string,
  ): Promise<SlackResponse> {
    return this.post("chat.postMessage", {
      channel,
      thread_ts: threadTs,
      markdown_text: truncateSlackMarkdown(markdown),
      ...(clientMsgId ? { client_msg_id: clientMsgId } : {}),
    });
  }

  async addReaction(
    channel: string,
    timestamp: string,
    reaction: string,
  ): Promise<SlackResponse> {
    return this.post("reactions.add", {
      channel,
      timestamp,
      name: reaction,
    });
  }

  async getChannelHistory(channel: string, limit = 10): Promise<SlackResponse> {
    return this.get("conversations.history", {
      channel,
      limit: String(limit),
    });
  }

  async getThreadReplies(
    channel: string,
    threadTs: string,
  ): Promise<SlackResponse> {
    return this.get("conversations.replies", {
      channel,
      ts: threadTs,
    });
  }

  async getUsers(limit = 100, cursor?: string): Promise<SlackResponse> {
    return this.get("users.list", {
      limit: String(Math.min(limit, 200)),
      team_id: this.teamId,
      cursor,
    });
  }

  async getUserInfo(userId: string): Promise<SlackResponse> {
    return this.get("users.info", { user: userId });
  }

  async getUserProfile(userId: string): Promise<SlackResponse> {
    return this.get("users.profile.get", {
      user: userId,
      include_labels: "true",
    });
  }

  async downloadFile(
    fileId: string,
    maxBytes = 10 * 1024 * 1024,
  ): Promise<DownloadedSlackFile> {
    const info = await this.get("files.info", { file: fileId });
    const file = info.file as {
      name?: unknown;
      mimetype?: unknown;
      size?: unknown;
      url_private_download?: unknown;
      url_private?: unknown;
    } | undefined;
    const name = typeof file?.name === "string" ? file.name : fileId;
    const mimetype =
      typeof file?.mimetype === "string" ? file.mimetype : "";
    const size = typeof file?.size === "number" ? file.size : undefined;
    const rawUrl =
      typeof file?.url_private_download === "string"
        ? file.url_private_download
        : typeof file?.url_private === "string"
          ? file.url_private
          : undefined;

    if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimetype)) {
      throw new Error(
        `Slack file ${fileId} is not a supported image (${mimetype || "unknown type"})`,
      );
    }
    if (size !== undefined && size > maxBytes) {
      throw new Error(
        `Slack file ${fileId} exceeds the ${maxBytes}-byte image limit`,
      );
    }
    if (!rawUrl) throw new Error(`Slack file ${fileId} has no download URL`);
    const url = new URL(rawUrl);
    if (
      url.protocol !== "https:" ||
      (url.hostname !== "slack.com" && !url.hostname.endsWith(".slack.com"))
    ) {
      throw new Error(`Slack file ${fileId} returned an invalid download URL`);
    }

    const response = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.botToken}` },
    });
    if (!response.ok) {
      throw new Error(`Slack file download failed with HTTP ${response.status}`);
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(
        `Slack file ${fileId} exceeds the ${maxBytes}-byte image limit`,
      );
    }
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > maxBytes) {
      throw new Error(`Slack file ${fileId} exceeds the ${maxBytes}-byte image limit`);
    }
    return { data, name, mimetype };
  }

  async uploadFile({
    channel,
    filePath,
    threadTs,
    title,
  }: {
    channel: string;
    filePath: string;
    threadTs?: string;
    title?: string;
  }): Promise<SlackResponse> {
    const file = await fs.readFile(filePath);
    const filename = path.basename(filePath);
    return this.uploadBytes({
      channel,
      data: file,
      filename,
      threadTs,
      title,
    });
  }

  async uploadBytes({
    channel,
    data,
    filename,
    threadTs,
    title,
  }: {
    channel: string;
    data: Uint8Array;
    filename: string;
    threadTs?: string;
    title?: string;
  }): Promise<SlackResponse> {
    const upload = await this.postForm("files.getUploadURLExternal", {
      filename,
      length: String(data.byteLength),
    });
    const uploadUrl = upload.upload_url;
    const fileId = upload.file_id;
    if (typeof uploadUrl !== "string" || typeof fileId !== "string") {
      throw new Error("Slack did not return an upload URL and file ID");
    }

    const uploadResponse = await this.fetchImpl(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.from(data),
    });
    if (!uploadResponse.ok) {
      throw new Error(
        `Slack file upload failed with HTTP ${uploadResponse.status}`,
      );
    }

    return this.post("files.completeUploadExternal", {
      files: [{ id: fileId, title: title || filename }],
      channel_id: channel,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  }

  private async get(
    method: string,
    params: Record<string, string | undefined>,
  ): Promise<SlackResponse> {
    const url = new URL(`${SLACK_API}/${method}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    return this.request(method, url, {
      headers: { Authorization: `Bearer ${this.botToken}` },
    });
  }

  private async post(
    method: string,
    body: Record<string, unknown>,
  ): Promise<SlackResponse> {
    return this.request(method, `${SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  private async postForm(
    method: string,
    body: Record<string, string>,
  ): Promise<SlackResponse> {
    return this.request(method, `${SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body),
    });
  }

  private async request(
    method: string,
    input: string | URL,
    init: RequestInit,
  ): Promise<SlackResponse> {
    const response = await this.fetchImpl(input, init);
    if (!response.ok) {
      throw new Error(`Slack ${method} failed with HTTP ${response.status}`);
    }

    const data = (await response.json()) as SlackResponse;
    if (!data.ok) {
      throw new Error(`Slack ${method} failed: ${data.error || "unknown error"}`);
    }
    return data;
  }
}
