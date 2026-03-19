import path from "path";
import { fileURLToPath } from "url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import ddTrace from "dd-trace";
import { DEFAULT_MAX_TURNS, DEFAULT_MAX_BUDGET_USD, DEFAULT_MODEL, REPO_PATH } from "./config.js";
import { buildMcpServers } from "./mcp.js";
import { getBaseSystemPrompt } from "./prompts/index.js";
import { AgentTelemetryTracker } from "./services/telemetry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPADRE_ROOT = path.resolve(__dirname, "..");

const llmobs = ddTrace.llmobs;

export interface TaskResult {
  result: string;
  sessionId: string;
  costUsd: number;
  durationMs: number;
  numTurns: number;
}

export interface StreamCallbacks {
  onTextDelta?: (text: string) => void;
  onToolStart?: (toolName: string) => void;
  onComplete?: () => void;
}

export interface Initiator {
  source: "slack" | "api" | "webhook";
  readableSource?: string;
  userId?: string;
  channel?: string;
  threadTs?: string;
  webhookSource?: string;
}

export interface RunTaskOptions {
  prompt: string;
  sessionId?: string;
  systemPrompt?: string;
  worktreePath?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  stream?: StreamCallbacks;
  initiator?: Initiator;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMessage = any;

export async function runTask({
  prompt,
  sessionId: resumeSessionId,
  systemPrompt,
  worktreePath,
  maxTurns = DEFAULT_MAX_TURNS,
  maxBudgetUsd = DEFAULT_MAX_BUDGET_USD,
  stream: streamCallbacks,
  initiator,
}: RunTaskOptions): Promise<TaskResult> {
  const cwd = worktreePath ?? REPO_PATH;
  if (!systemPrompt) {
    systemPrompt = getBaseSystemPrompt(cwd);
  }

  // Detach from the incoming distributed trace so LLMObs spans are rooted
  // under the compadre ml_app instead of inheriting the caller's ml_app.
  return ddTrace.scope().activate(null as unknown as ddTrace.Span, () => {
    return llmobs.trace({ name: "compadre-agent", kind: "agent" }, async () => {
      llmobs.annotate({
        inputData: prompt,
        metadata: {
          maxTurns,
          maxBudgetUsd,
          resumed: !!resumeSessionId,
          ...(initiator && {
            initiatorSource: initiator.source,
            ...(initiator.readableSource && { readableSource: initiator.readableSource }),
            ...(initiator.userId && { initiatorUserId: initiator.userId }),
            ...(initiator.channel && { initiatorChannel: initiator.channel }),
            ...(initiator.threadTs && { initiatorThreadTs: initiator.threadTs }),
            ...(initiator.webhookSource && { initiatorWebhookSource: initiator.webhookSource }),
          }),
        },
      });

      const mcpServers = await buildMcpServers();
      const telemetry = new AgentTelemetryTracker(prompt);

      const stream = query({
        prompt,
        options: {
          cwd,
          env: {
            ...process.env as Record<string, string>,
            GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(cwd)),
          },
          model: DEFAULT_MODEL,
          systemPrompt,
          maxTurns,
          maxBudgetUsd,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          includePartialMessages: true,
          settingSources: ["project"],
          plugins: [
            { type: "local" as const, path: COMPADRE_ROOT },
            { type: "local" as const, path: path.resolve(cwd) },
          ],
          ...(resumeSessionId ? { resume: resumeSessionId } : {}),
          allowedTools: [
            "Skill",
            "Agent",
            "TaskOutput",
            "Read",
            "Glob",
            "Grep",
            "Bash",
            "Edit",
            "Write",
            "WebSearch",
            "WebFetch",
            "mcp__datadog-mcp__*",
            "mcp__slack__*",
            "mcp__linear__*",
            "mcp__github__*",
            "mcp__render__*",
            "mcp__postgres__*",
            "mcp__s3__*",
          ],
          mcpServers,
        },
      });

      let sessionId: string | undefined;
      let hasStreamedText = false;

      try {
        for await (const message of stream) {
          if (message.type === "system" && message.subtype === "init") {
            sessionId = message.session_id;
            console.log(`[agent] session ${resumeSessionId ? "resumed" : "started"}: ${sessionId}`);
          }

          if (message.type === "stream_event") {
            const event = (message as AnyMessage).event;
            if (event.type === "content_block_start" && event.content_block?.type === "text") {
              if (hasStreamedText) {
                streamCallbacks?.onTextDelta?.("\n\n");
              }
              hasStreamedText = true;
            }
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
              streamCallbacks?.onTextDelta?.(event.delta.text);
            }
            telemetry.onStreamEvent(event);
          }

          if (message.type === "assistant") {
            const msg = (message as AnyMessage).message;
            const newToolBlocks = telemetry.onAssistantMessage(msg);

            for (const block of newToolBlocks) {
              streamCallbacks?.onToolStart?.(block.name);
            }

            for (const block of (msg.content ?? []).filter((b: AnyMessage) => b.type === "text")) {
              console.log(`[agent] ${block.text.slice(0, 200)}`);
            }
          }

          if (message.type === "user") {
            telemetry.onUserMessage(message as AnyMessage);
          }

          if (message.type === "result") {
            const resultMsg = message as AnyMessage;
            telemetry.onResult(resultMsg);

            if (resultMsg.subtype === "success") {
              return {
                result: resultMsg.result,
                sessionId: sessionId ?? resumeSessionId ?? "",
                costUsd: resultMsg.total_cost_usd,
                durationMs: resultMsg.duration_ms,
                numTurns: resultMsg.num_turns,
              };
            }
            throw new Error(
              `Agent task failed (${resultMsg.subtype}): ${
                "errors" in resultMsg
                  ? (resultMsg.errors as string[]).join(", ")
                  : "unknown error"
              }`
            );
          }
        }

        throw new Error("Agent stream ended without result");
      } finally {
        telemetry.cleanup();
        streamCallbacks?.onComplete?.();
      }
    });
  });
}
