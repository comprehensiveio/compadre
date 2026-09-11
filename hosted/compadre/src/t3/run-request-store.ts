import type { ProviderAction } from "./provider-actions.js";
import type { MetadataStore } from "./storage.js";
import type { T3ModelSelection, T3TurnDispatch } from "./client.js";
import { MAX_INPUT_REQUEST_BYTES, type InputFile } from "../services/input-files.js";
import { createHash } from "node:crypto";
import type { T3ArtifactObjectStore } from "./artifact-store.js";

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
  providerAction?: ProviderAction;
  runId: string;
  runtimeMode?: "full-access" | "approval-required" | "auto-accept-edits" | "auto";
  interactionMode?: "default" | "plan";
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
  constructor(
    private readonly metadata: MetadataStore,
    private readonly objects?: Pick<T3ArtifactObjectStore, "put" | "get">,
    private readonly beforePersist?: (threadId: string) => Promise<void>,
  ) {}

  async saveRequest(request: NativeT3RunRequest): Promise<void> {
    if (request.inputFiles.reduce((total, file) => total + file.sizeBytes, 0) > MAX_INPUT_REQUEST_BYTES) {
      throw new Error("Combined input attachments exceed the 100 MiB request limit");
    }
    const inputFiles = [];
    for (const { dataBase64, ...file } of request.inputFiles) {
      if (!this.objects) throw new Error("Native input attachment object storage is not configured");
      const bytes = Buffer.from(dataBase64, "base64");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const runKey = createHash("sha256").update(request.runId).digest("hex");
      const objectKey = `attachments/native-inputs/v1/${runKey}/${sha256}`;
      await this.objects.put({ key: objectKey, artifactId: sha256, mimetype: file.mimetype, bytes });
      inputFiles.push({ ...file, objectKey, sha256 });
    }
    await this.beforePersist?.(request.canonicalThreadId);
    await this.metadata.set(REQUEST_NAMESPACE, request.runId, { ...request, inputFiles });
  }

  async getRequest(runId: string, options?: { includeInputFiles: boolean }): Promise<NativeT3RunRequest | null> {
    const value = await this.metadata.get(REQUEST_NAMESPACE, runId);
    if (value === null) return null;
    if (!isRecord(value) || typeof value.runId !== "string") {
      throw new Error(`Invalid persisted native T3 run request for ${runId}`);
    }
    const request = value as unknown as Omit<NativeT3RunRequest, "inputFiles"> & {
      inputFiles: Array<Omit<InputFile, "dataBase64"> & { objectKey: string; sha256: string }>;
    };
    if (options?.includeInputFiles === false) return { ...request, inputFiles: [] };
    const inputFiles: InputFile[] = [];
    for (const file of request.inputFiles) {
      if (typeof file.objectKey !== "string" || typeof file.sha256 !== "string") {
        throw new Error("Native input attachments require object references; migrate inline records before recovery");
      }
      if (!this.objects) throw new Error("Native input attachment object storage is not configured");
      const bytes = await this.objects.get(file.objectKey);
      if (bytes.byteLength !== file.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
        throw new Error("Native input attachment failed integrity validation");
      }
      inputFiles.push({ name: file.name, mimetype: file.mimetype, sizeBytes: file.sizeBytes, dataBase64: Buffer.from(bytes).toString("base64") });
    }
    return { ...request, inputFiles };
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

}
