import crypto from "node:crypto";
import { z } from "zod";
import {
  runConversation,
  type ConversationResult,
} from "../conversation.js";
import {
  currentRepoRevision,
  ensureRepo,
} from "../repo.js";
import { releaseAguiThread } from "../tanstack/runtime.js";
import { getSlackStreamingSystemPrompt } from "../prompts/index.js";
import {
  MAX_SLACK_INPUT_FILES,
  slackFileReferenceSchema,
} from "../services/slack-files.js";
import { workflowErrorDetails } from "./diagnostics.js";

export const agentWorkflowInputSchema = z.object({
  runId: z.string().trim().min(1).optional(),
  prompt: z.string().trim().min(1),
  transcriptUserMessage: z.string().optional(),
  threadId: z.string().trim().min(1).optional(),
  provider: z.enum(["claude-code", "codex"]).optional(),
  profile: z.enum(["claude-code", "codex", "fable"]).optional(),
  responseMode: z.enum(["default", "slack-streaming"]).optional(),
  persistThread: z.boolean().optional(),
  slackFiles: z
    .array(slackFileReferenceSchema)
    .max(MAX_SLACK_INPUT_FILES)
    .optional(),
});

export type AgentWorkflowInput = z.infer<typeof agentWorkflowInputSchema>;

export interface WorkflowTimings {
  repositoryMs: number;
  firstActivityMs: number | null;
  agentMs: number;
  totalMs: number;
}

export interface AgentWorkflowResult extends ConversationResult {
  repositoryRevision: string | null;
  timings: WorkflowTimings;
}

export interface RepositoryProbeResult {
  repositoryRevision: string | null;
  repositoryMs: number;
  totalMs: number;
}

export interface AgentWorkflowDependencies {
  ensureRepository(): void;
  repositoryRevision(): string | undefined;
  runConversation: typeof runConversation;
  releaseThread(threadId: string): Promise<void>;
  now(): number;
  createId(): string;
}

const defaultDependencies: AgentWorkflowDependencies = {
  ensureRepository: ensureRepo,
  repositoryRevision: currentRepoRevision,
  runConversation,
  releaseThread: releaseAguiThread,
  now: Date.now,
  createId: () => crypto.randomUUID(),
};

function prepareRepository(
  dependencies: AgentWorkflowDependencies,
): { durationMs: number; revision: string | null } {
  const startedAt = dependencies.now();
  dependencies.ensureRepository();
  return {
    durationMs: dependencies.now() - startedAt,
    revision: dependencies.repositoryRevision() ?? null,
  };
}

/** Measure the cold repository boundary without paying for an agent request. */
export async function executeRepositoryProbe(
  dependencies: AgentWorkflowDependencies = defaultDependencies,
): Promise<RepositoryProbeResult> {
  const startedAt = dependencies.now();
  const repository = prepareRepository(dependencies);
  const result = {
    repositoryRevision: repository.revision,
    repositoryMs: repository.durationMs,
    totalMs: dependencies.now() - startedAt,
  };
  console.log("[workflow-agent] repository probe", result);
  return result;
}

/**
 * Execute one coding-agent turn. Persisted threads reuse their Daytona
 * workspace; generated one-shot threads remain ephemeral.
 */
export async function executeAgentWorkflow(
  rawInput: unknown,
  dependencies: AgentWorkflowDependencies = defaultDependencies,
): Promise<AgentWorkflowResult> {
  const input = agentWorkflowInputSchema.parse(rawInput);
  const startedAt = dependencies.now();
  // The coding checkout lives in Daytona. Avoid cloning or refreshing the
  // application repository in the persistent relay request path.
  const repository = { durationMs: 0, revision: null };
  const threadId = input.threadId ?? `workflow-${dependencies.createId()}`;
  const agentStartedAt = dependencies.now();
  let firstActivityAt: number | undefined;

  let operationFailed = false;
  let cleanupFailed = false;
  let cleanupError: unknown;
  let workflowResult!: AgentWorkflowResult;
  try {
    const result = await dependencies.runConversation({
      runId: input.runId,
      prompt: input.prompt,
      transcriptUserMessage:
        input.transcriptUserMessage ?? input.prompt,
      threadId,
      provider: input.provider,
      profile: input.profile,
      persistThread: input.persistThread ?? input.threadId !== undefined,
      slackFiles: input.slackFiles,
      systemPrompt:
        input.responseMode === "slack-streaming"
          ? (worktreePath) => getSlackStreamingSystemPrompt(worktreePath)
          : undefined,
      stream: {
        onTextDelta: () => {
          firstActivityAt ??= dependencies.now();
        },
        onToolStart: () => {
          firstActivityAt ??= dependencies.now();
        },
      },
    });
    const completedAt = dependencies.now();
    workflowResult = {
      ...result,
      repositoryRevision: repository.revision,
      timings: {
        repositoryMs: repository.durationMs,
        firstActivityMs:
          firstActivityAt === undefined
            ? null
            : firstActivityAt - startedAt,
        agentMs: completedAt - agentStartedAt,
        totalMs: completedAt - startedAt,
      },
    };
    console.log("[workflow-agent] run completed", {
      threadId,
      provider: result.provider,
      model: result.model,
      revision: repository.revision,
      ...workflowResult.timings,
    });
  } catch (error) {
    operationFailed = true;
    console.error("[workflow-agent] run failed", {
      runId: input.runId ?? null,
      threadId,
      provider: input.provider ?? null,
      revision: repository.revision,
      elapsedMs: dependencies.now() - startedAt,
      ...workflowErrorDetails(error),
    });
    throw error;
  } finally {
    try {
      if (!(input.persistThread ?? input.threadId !== undefined)) {
        await dependencies.releaseThread(threadId);
      }
    } catch (error) {
      if (operationFailed) {
        console.warn("[workflow-agent] thread cleanup failed", {
          threadId,
          error,
        });
      } else {
        cleanupFailed = true;
        cleanupError = error;
      }
    }
  }
  if (cleanupFailed) throw cleanupError;
  return workflowResult;
}
