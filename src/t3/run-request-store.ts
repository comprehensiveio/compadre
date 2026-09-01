import type { MetadataStore } from "./storage.js";
import type { T3ModelSelection, T3TurnDispatch } from "./client.js";
import type { InputFile } from "../services/input-files.js";

const REQUEST_NAMESPACE = "compadre.t3.run-requests.v1";
const DISPATCH_NAMESPACE = "compadre.t3.run-dispatches.v1";

export interface NativeT3RunSlackMirror {
  channelId: string;
  threadTs: string;
  recipientUserId?: string;
  recipientTeamId?: string;
  userMessage: string;
  detailsUrl?: string;
}

/**
 * Everything the drive activity needs to execute one native T3 run without
 * the originating HTTP request. Persisted before the workflow starts so the
 * workflow input stays small (attachments can reach 50 MiB) and a retried or
 * relocated activity can rebuild the run from durable state alone.
 */
export interface NativeT3RunRequest {
  runId: string;
  canonicalThreadId: string;
  provider: "claude-code" | "codex";
  title: string;
  /** Final provider prompt including trusted-requester and artifact preamble. */
  text: string;
  modelSelection: T3ModelSelection;
  inputFiles: InputFile[];
  blockedSlackDestination?: {
    channelId: string;
    threadTs: string;
  };
  slackMirror?: NativeT3RunSlackMirror;
  /**
   * Slack thread that receives generated artifact uploads. Present for any
   * thread with a linked Slack binding, including Slack-originated turns
   * whose final text delivery belongs to the controller outbox.
   */
  slackArtifactDestination?: {
    channelId: string;
    threadTs: string;
    recipientTeamId?: string;
  };
  collectArtifacts: boolean;
  createdAt: string;
}

/**
 * Durable record that the worker turn was dispatched. Written immediately
 * after gateway.send succeeds; its presence tells a retried drive activity to
 * reattach to the existing turn instead of dispatching a duplicate message.
 */
export interface NativeT3RunDispatch {
  canonicalThreadId: string;
  dispatch: T3TurnDispatch;
  dispatchedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDispatch(value: unknown): value is T3TurnDispatch {
  if (!isRecord(value)) return false;
  return (
    typeof value.sequence === "number" &&
    typeof value.commandId === "string" &&
    typeof value.messageId === "string" &&
    typeof value.threadId === "string" &&
    typeof value.createdAt === "string"
  );
}

export class NativeT3RunRequestStore {
  constructor(private readonly metadata: MetadataStore) {}

  async saveRequest(request: NativeT3RunRequest): Promise<void> {
    await this.metadata.set(REQUEST_NAMESPACE, request.runId, request);
  }

  async getRequest(runId: string): Promise<NativeT3RunRequest | null> {
    const value = await this.metadata.get(REQUEST_NAMESPACE, runId);
    if (value === null) return null;
    if (!isRecord(value) || typeof value.runId !== "string") {
      throw new Error(`Invalid persisted native T3 run request for ${runId}`);
    }
    return value as unknown as NativeT3RunRequest;
  }

  async saveDispatch(runId: string, record: NativeT3RunDispatch): Promise<void> {
    await this.metadata.set(DISPATCH_NAMESPACE, runId, record);
  }

  async getDispatch(runId: string): Promise<NativeT3RunDispatch | null> {
    const value = await this.metadata.get(DISPATCH_NAMESPACE, runId);
    if (value === null) return null;
    if (
      !isRecord(value) ||
      typeof value.canonicalThreadId !== "string" ||
      !isDispatch(value.dispatch)
    ) {
      throw new Error(`Invalid persisted native T3 run dispatch for ${runId}`);
    }
    return value as unknown as NativeT3RunDispatch;
  }

  /**
   * Attachments dominate the request record's size and are only needed until
   * dispatch. Terminal runs keep a trimmed request for diagnostics.
   */
  async trimTerminalRequest(runId: string): Promise<void> {
    const request = await this.getRequest(runId);
    if (!request || request.inputFiles.length === 0) return;
    await this.metadata.set(REQUEST_NAMESPACE, runId, {
      ...request,
      inputFiles: [],
    });
  }
}
