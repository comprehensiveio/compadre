/**
 * Standalone stdio MCP server exposing read-only S3 tools.
 *
 * Tools: list_buckets, list_objects, get_object, get_object_metadata, search_objects
 *
 * Expects AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION in env.
 */

import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const s3 = new S3Client({
  region: process.env.AWS_REGION ?? "us-west-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const server = new McpServer({
  name: "s3",
  version: "1.0.0",
});

server.tool("list_buckets", "List all S3 buckets in the account", {}, async () => {
  const { Buckets = [] } = await s3.send(new ListBucketsCommand({}));
  const buckets = Buckets.map((b) => ({
    name: b.Name,
    creationDate: b.CreationDate?.toISOString(),
  }));
  return { content: [{ type: "text", text: JSON.stringify(buckets, null, 2) }] };
});

server.tool(
  "list_objects",
  "List objects in an S3 bucket with optional prefix filter",
  {
    bucket: z.string().describe("S3 bucket name"),
    prefix: z.string().optional().describe("Key prefix to filter by"),
    max_keys: z.number().optional().default(100).describe("Max objects to return (default 100)"),
  },
  async ({ bucket, prefix, max_keys }) => {
    const { Contents = [], IsTruncated } = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: max_keys,
      }),
    );
    const objects = Contents.map((o) => ({
      key: o.Key,
      size: o.Size,
      lastModified: o.LastModified?.toISOString(),
    }));
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ objects, truncated: IsTruncated }, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "get_object",
  "Get the contents of an S3 object (text-based files; returns UTF-8 string)",
  {
    bucket: z.string().describe("S3 bucket name"),
    key: z.string().describe("Object key"),
  },
  async ({ bucket, key }) => {
    const { Body } = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    const text = await Body!.transformToString("utf-8");
    return { content: [{ type: "text", text }] };
  },
);

server.tool(
  "get_object_metadata",
  "Get metadata for an S3 object without downloading the body (content type, size, last modified, custom metadata)",
  {
    bucket: z.string().describe("S3 bucket name"),
    key: z.string().describe("Object key"),
  },
  async ({ bucket, key }) => {
    const res = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    const metadata = {
      contentType: res.ContentType,
      contentLength: res.ContentLength,
      lastModified: res.LastModified?.toISOString(),
      eTag: res.ETag,
      metadata: res.Metadata,
    };
    return { content: [{ type: "text", text: JSON.stringify(metadata, null, 2) }] };
  },
);

server.tool(
  "search_objects",
  "Search for objects in an S3 bucket by matching keys against a substring or regex pattern. Lists all objects under the given prefix and filters client-side.",
  {
    bucket: z.string().describe("S3 bucket name"),
    pattern: z.string().describe("Substring or regex pattern to match against object keys"),
    prefix: z.string().optional().describe("Key prefix to narrow the search scope"),
    max_results: z.number().optional().default(50).describe("Max matching objects to return (default 50)"),
  },
  async ({ bucket, pattern, prefix, max_results }) => {
    const regex = new RegExp(pattern);
    const matches: { key: string; size: number | undefined; lastModified: string | undefined }[] = [];
    let continuationToken: string | undefined;

    do {
      const { Contents = [], IsTruncated, NextContinuationToken } = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );

      for (const obj of Contents) {
        if (obj.Key && regex.test(obj.Key)) {
          matches.push({
            key: obj.Key,
            size: obj.Size,
            lastModified: obj.LastModified?.toISOString(),
          });
          if (matches.length >= max_results) break;
        }
      }

      continuationToken = IsTruncated ? NextContinuationToken : undefined;
    } while (continuationToken && matches.length < max_results);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ matches, total: matches.length }, null, 2),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
