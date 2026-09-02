import { randomUUID } from "node:crypto";
import { log } from "../logging.js";
import { z } from "zod";

const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const ENVIRONMENT_BOOTSTRAP_TOKEN_TYPE =
  "urn:t3:params:oauth:token-type:environment-bootstrap";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 350;
const TRANSIENT_READ_FAILURE_WINDOW_MS = 2 * 60_000;

export type T3RuntimeMode =
  "approval-required" | "auto-accept-edits" | "auto" | "full-access";
export type T3InteractionMode = "default" | "plan";

export interface T3ProviderOptionSelection {
  id: string;
  value: string | boolean;
}

export interface T3ModelSelection {
  instanceId: string;
  model: string;
  options?: ReadonlyArray<T3ProviderOptionSelection>;
}

/** Provenance for machine-triggered turns (origin "trigger"). */
export interface T3TriggerAttribution {
  triggerId: string;
  name: string;
  triggerType: "cron";
  cronExpression: string;
  timezone?: string;
}

export interface T3MessageAttribution {
  userId: string;
  displayName: string;
  avatarUrl?: string;
  origin: "web" | "slack" | "api" | "trigger";
  slack?: {
    workspaceId: string;
    userId: string;
    channelId: string;
    messageTs: string;
    threadTs?: string;
    threadUrl?: string;
    participants?: ReadonlyArray<{
      userId: string;
      displayName: string;
      avatarUrl?: string;
      origins: ReadonlyArray<"web" | "slack" | "api" | "trigger">;
    }>;
  };
  /** Present when origin is "trigger": machine provenance shown in the web UI. */
  trigger?: T3TriggerAttribution;
}

export interface T3InputFile {
  name: string;
  mimetype: string;
  sizeBytes: number;
  dataBase64: string;
}

function inlineAttachment(file: T3InputFile) {
  return {
    type: file.mimetype.toLowerCase().startsWith("image/")
      ? ("image" as const)
      : ("file" as const),
    name: file.name,
    mimeType: file.mimetype,
    sizeBytes: file.sizeBytes,
    dataUrl: `data:${file.mimetype};base64,${file.dataBase64}`,
  };
}

export interface T3Project {
  id: string;
  title: string;
  workspaceRoot: string;
  defaultModelSelection: T3ModelSelection | null;
}

export interface T3Message {
  readonly [key: string]: unknown;
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  turnId: string | null;
  streaming: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface T3LatestTurn {
  readonly [key: string]: unknown;
  turnId: string;
  state: "running" | "interrupted" | "completed" | "error";
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: string | null;
}

export interface T3Thread {
  readonly [key: string]: unknown;
  id: string;
  projectId: string;
  title: string;
  modelSelection: T3ModelSelection;
  latestTurn: T3LatestTurn | null;
  messages: ReadonlyArray<T3Message>;
  session: {
    status:
      | "idle"
      | "starting"
      | "running"
      | "ready"
      | "interrupted"
      | "stopped"
      | "error";
    activeTurnId: string | null;
    lastError: string | null;
  } | null;
}

export interface T3ThreadSnapshot {
  readonly [key: string]: unknown;
  snapshotSequence: number;
  thread: T3Thread;
}

const INCOMPLETE_PROVIDER_STOP_REASONS = new Set([
  "length",
  "max_tokens",
  "max_turn_requests",
  "tool_calls",
  "tool_use",
]);

/** Return a provider stop reason only when it means the answer is incomplete. */
export function incompleteProviderStopReason(
  snapshot: T3ThreadSnapshot,
  turnId?: string | null,
): string | undefined {
  const rawActivities = snapshot.thread.activities;
  if (!Array.isArray(rawActivities)) return undefined;
  for (let index = rawActivities.length - 1; index >= 0; index -= 1) {
    const raw = rawActivities[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const activity = raw as Record<string, unknown>;
    if (activity.kind !== "provider.turn.completed") continue;
    if (
      turnId &&
      typeof activity.turnId === "string" &&
      activity.turnId !== turnId
    ) {
      continue;
    }
    const payload = activity.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      continue;
    }
    const reason = (payload as Record<string, unknown>).stopReason;
    if (
      typeof reason === "string" &&
      INCOMPLETE_PROVIDER_STOP_REASONS.has(reason.toLowerCase())
    ) {
      return reason;
    }
  }
  return undefined;
}

export interface T3OrchestrationSnapshot {
  snapshotSequence: number;
  projects: ReadonlyArray<T3Project>;
  threads: ReadonlyArray<T3Thread>;
  updatedAt: string;
}

export interface T3EnvironmentDescriptor {
  environmentId: string;
  label: string;
  serverVersion: string;
}

export type T3GatewayErrorKind =
  "transport" | "http" | "protocol" | "timeout" | "aborted";

export class T3GatewayError extends Error {
  constructor(
    readonly kind: T3GatewayErrorKind,
    readonly operation: string,
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "T3GatewayError";
  }
}

function isTransientSnapshotFailure(error: unknown): boolean {
  if (!(error instanceof T3GatewayError)) return false;
  if (error.kind === "transport" || error.kind === "timeout") return true;
  return (
    (error.kind === "http" || error.kind === "protocol") &&
    error.status !== undefined &&
    error.status >= 500 &&
    error.status <= 504
  );
}

const modelSelectionSchema = z.object({
  instanceId: z.string().min(1),
  model: z.string().min(1),
  options: z
    .array(
      z.object({
        id: z.string().min(1),
        value: z.union([z.string().min(1), z.boolean()]),
      }),
    )
    .optional(),
});

const projectSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  workspaceRoot: z.string().min(1),
  defaultModelSelection: modelSelectionSchema.nullable(),
});

const messageSchema = z
  .object({
    id: z.string().min(1),
    role: z.enum(["user", "assistant", "system"]),
    text: z.string(),
    turnId: z.string().nullable(),
    streaming: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

const latestTurnSchema = z
  .object({
    turnId: z.string().min(1),
    state: z.enum(["running", "interrupted", "completed", "error"]),
    requestedAt: z.string(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    assistantMessageId: z.string().nullable(),
  })
  .passthrough();

const threadSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    title: z.string(),
    modelSelection: modelSelectionSchema,
    latestTurn: latestTurnSchema.nullable(),
    messages: z.array(messageSchema),
    session: z
      .object({
        status: z.enum([
          "idle",
          "starting",
          "running",
          "ready",
          "interrupted",
          "stopped",
          "error",
        ]),
        activeTurnId: z.string().nullable(),
        lastError: z.string().nullable(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();

const orchestrationSnapshotSchema = z.object({
  snapshotSequence: z.number().int().nonnegative(),
  projects: z.array(projectSchema),
  threads: z.array(threadSchema),
  updatedAt: z.string(),
});

const environmentDescriptorSchema = z
  .object({
    environmentId: z.string().min(1),
    label: z.string().min(1),
    serverVersion: z.string().min(1),
  })
  .passthrough();

const threadSnapshotSchema = z
  .object({
    snapshotSequence: z.number().int().nonnegative(),
    thread: threadSchema,
  })
  .passthrough();

/**
 * Decode a persisted or remote native-T3 thread snapshot without discarding
 * activity, checkpoint, attachment, and provider-specific fields that this
 * coordinator does not otherwise need to understand.
 */
export function decodeT3ThreadSnapshot(value: unknown): T3ThreadSnapshot {
  return threadSnapshotSchema.parse(value) as T3ThreadSnapshot;
}

const dispatchResultSchema = z.object({
  sequence: z.number().int().nonnegative(),
});

const accessTokenSchema = z.object({
  access_token: z.string().min(1),
  issued_token_type: z.literal(ACCESS_TOKEN_TYPE),
  token_type: z.enum(["Bearer", "DPoP"]),
  expires_in: z.number(),
  scope: z.string(),
});

const pairingCredentialSchema = z.object({
  id: z.string().min(1),
  credential: z.string().min(1),
  label: z.string().optional(),
  expiresAt: z.string(),
});

type Fetch = typeof globalThis.fetch;
type IdFactory = () => string;
type Now = () => Date;

interface ClientOptions {
  fetch?: Fetch;
  idFactory?: IdFactory;
  now?: Now;
  timeoutMs?: number;
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  form?: URLSearchParams;
  schema: z.ZodType;
  signal?: AbortSignal;
  authenticated?: boolean;
}

function normalizedBaseUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  if (parsed.username || parsed.password) {
    throw new Error("T3 base URL must not contain credentials");
  }
  return parsed.toString().replace(/\/$/, "");
}

function errorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record._tag === "string") return record._tag;
  if (typeof record.code === "string") return record.code;
  if (typeof record.reason === "string") return record.reason;
  return undefined;
}

function terminalTurn(thread: T3Thread): boolean {
  return (
    thread.latestTurn !== null &&
    ["completed", "error", "interrupted"].includes(thread.latestTurn.state)
  );
}

/**
 * Finds a provider failure correlated to a user message that never received a
 * native turn ID, including resumed threads that still retain an older turn.
 */
export function preTurnStartFailure(
  snapshot: T3ThreadSnapshot,
  requestedMessageId?: string,
): { message: string; createdAt?: string } | undefined {
  const session = snapshot.thread.session;
  if (
    !session?.lastError ||
    (session.status !== "stopped" && session.status !== "error")
  ) {
    return undefined;
  }
  const requestedMessage = requestedMessageId
    ? snapshot.thread.messages.find(
        (message) =>
          message.id === requestedMessageId && message.role === "user",
      )
    : [...snapshot.thread.messages]
        .reverse()
        .find((message) => message.role === "user");
  if (!requestedMessage || requestedMessage.turnId !== null) return undefined;
  const requestedAt = Date.parse(requestedMessage.createdAt);
  const rawActivities = snapshot.thread.activities;
  if (!Array.isArray(rawActivities)) return undefined;
  let failure: Record<string, unknown> | undefined;
  for (let index = rawActivities.length - 1; index >= 0; index -= 1) {
    const raw: unknown = rawActivities[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const activity = raw as Record<string, unknown>;
    if (
      activity.kind !== "provider.turn.start.failed" &&
      activity.kind !== "runtime.error"
    ) {
      continue;
    }
    const createdAt =
      typeof activity.createdAt === "string"
        ? Date.parse(activity.createdAt)
        : Number.NaN;
    if (
      !Number.isFinite(requestedAt) ||
      (Number.isFinite(createdAt) && createdAt >= requestedAt)
    ) {
      failure = activity;
      break;
    }
  }
  if (!failure) return undefined;
  return {
    message: session.lastError,
    ...(typeof failure.createdAt === "string"
      ? { createdAt: failure.createdAt }
      : {}),
  };
}

export interface T3TurnDispatch {
  sequence: number;
  commandId: string;
  messageId: string;
  threadId: string;
  createdAt: string;
}

export class T3Client {
  readonly baseUrl: string;
  private readonly fetch: Fetch;
  private readonly idFactory: IdFactory;
  private readonly now: Now;
  private readonly timeoutMs: number;

  constructor(
    baseUrl: string,
    private readonly accessToken: string,
    options: ClientOptions = {},
  ) {
    this.baseUrl = normalizedBaseUrl(baseUrl);
    this.fetch = options.fetch ?? globalThis.fetch;
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async request<T>(
    operation: string,
    pathname: string,
    options: RequestOptions,
  ): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const headers = new Headers({ accept: "application/json" });
    if (options.authenticated !== false) {
      headers.set("authorization", `Bearer ${this.accessToken}`);
    }
    let body: string | undefined;
    if (options.form) {
      headers.set("content-type", "application/x-www-form-urlencoded");
      body = options.form.toString();
    } else if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.fetch(new URL(pathname, `${this.baseUrl}/`), {
        method: options.method ?? "GET",
        headers,
        body,
        signal,
      });
    } catch (cause) {
      const aborted = signal.aborted;
      const callerAborted = options.signal?.aborted === true;
      throw new T3GatewayError(
        callerAborted ? "aborted" : aborted ? "timeout" : "transport",
        operation,
        callerAborted
          ? `T3 ${operation} was aborted`
          : aborted
            ? `T3 ${operation} timed out`
            : `T3 ${operation} could not reach the environment`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new T3GatewayError(
        "protocol",
        operation,
        `T3 ${operation} returned a non-JSON response`,
        response.status,
      );
    }
    if (!response.ok) {
      throw new T3GatewayError(
        "http",
        operation,
        `T3 ${operation} failed with HTTP ${response.status}`,
        response.status,
        errorCode(payload),
      );
    }
    const decoded = options.schema.safeParse(payload);
    if (!decoded.success) {
      throw new T3GatewayError(
        "protocol",
        operation,
        `T3 ${operation} returned an incompatible payload`,
        response.status,
      );
    }
    return decoded.data as T;
  }

  private async readWithTransientRetry<T>(
    operation: string,
    pathname: string,
    options: RequestOptions,
  ): Promise<T> {
    const deadline = Date.now() + TRANSIENT_READ_FAILURE_WINDOW_MS;
    while (true) {
      try {
        return await this.request<T>(operation, pathname, options);
      } catch (error) {
        if (!isTransientSnapshotFailure(error) || Date.now() >= deadline) {
          throw error;
        }
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(
            new T3GatewayError(
              "aborted",
              operation,
              `T3 ${operation} was aborted`,
            ),
          );
        };
        const timer = setTimeout(() => {
          options.signal?.removeEventListener("abort", onAbort);
          resolve();
        }, DEFAULT_POLL_INTERVAL_MS);
        options.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  snapshot(signal?: AbortSignal): Promise<T3OrchestrationSnapshot> {
    return this.readWithTransientRetry("snapshot", "/api/orchestration/snapshot", {
      schema: orchestrationSnapshotSchema,
      signal,
    });
  }

  environmentDescriptor(
    signal?: AbortSignal,
  ): Promise<T3EnvironmentDescriptor> {
    return this.readWithTransientRetry(
      "environment descriptor",
      "/.well-known/t3/environment",
      {
        schema: environmentDescriptorSchema,
        signal,
        authenticated: false,
      },
    );
  }

  threadSnapshot(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<T3ThreadSnapshot> {
    return this.readWithTransientRetry(
      "thread snapshot",
      `/api/orchestration/threads/${encodeURIComponent(threadId)}`,
      { schema: threadSnapshotSchema, signal },
    );
  }

  async dispatch(command: unknown, signal?: AbortSignal): Promise<number> {
    const result = await this.request<{ sequence: number }>(
      "command dispatch",
      "/api/orchestration/dispatch",
      {
        method: "POST",
        body: command,
        schema: dispatchResultSchema,
        signal,
      },
    );
    return result.sequence;
  }

  async startNewThread(input: {
    threadId?: string;
    messageId?: string;
    projectId: string;
    title: string;
    text: string;
    displayText?: string;
    attribution?: T3MessageAttribution;
    inputFiles?: ReadonlyArray<T3InputFile>;
    modelSelection: T3ModelSelection;
    runtimeMode?: T3RuntimeMode;
    interactionMode?: T3InteractionMode;
    branch?: string | null;
    worktreePath?: string | null;
    signal?: AbortSignal;
  }): Promise<T3TurnDispatch> {
    const threadId = input.threadId ?? this.idFactory();
    const createCommandId = this.idFactory();
    const createdAt = this.now().toISOString();
    const runtimeMode = input.runtimeMode ?? "full-access";
    const interactionMode = input.interactionMode ?? "default";
    // T3's WebSocket dispatcher expands turn.bootstrap, but its HTTP
    // dispatcher currently sends commands directly to the engine. Keep the
    // headless HTTP path portable by creating the thread explicitly first.
    await this.dispatch(
      {
        type: "thread.create",
        commandId: createCommandId,
        threadId,
        projectId: input.projectId,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode,
        interactionMode,
        branch: input.branch ?? null,
        worktreePath: input.worktreePath ?? null,
        createdAt,
      },
      input.signal,
    );
    return this.startTurn({
      threadId,
      messageId: input.messageId,
      text: input.text,
      displayText: input.displayText,
      attribution: input.attribution,
      inputFiles: input.inputFiles,
      modelSelection: input.modelSelection,
      runtimeMode,
      interactionMode,
      signal: input.signal,
    });
  }

  async startTurn(input: {
    threadId: string;
    messageId?: string;
    text: string;
    displayText?: string;
    attribution?: T3MessageAttribution;
    inputFiles?: ReadonlyArray<T3InputFile>;
    modelSelection: T3ModelSelection;
    runtimeMode?: T3RuntimeMode;
    interactionMode?: T3InteractionMode;
    signal?: AbortSignal;
  }): Promise<T3TurnDispatch> {
    const commandId = this.idFactory();
    const messageId = input.messageId ?? this.idFactory();
    const createdAt = this.now().toISOString();
    const sequence = await this.dispatch(
      {
        type: "thread.turn.start",
        commandId,
        threadId: input.threadId,
        message: {
          messageId,
          role: "user",
          text: input.displayText ?? input.text,
          ...(input.displayText && input.displayText !== input.text
            ? { providerPrompt: input.text }
            : {}),
          ...(input.attribution ? { attribution: input.attribution } : {}),
          attachments: (input.inputFiles ?? []).map(inlineAttachment),
        },
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode ?? "full-access",
        interactionMode: input.interactionMode ?? "default",
        createdAt,
      },
      input.signal,
    );
    return {
      sequence,
      commandId,
      messageId,
      threadId: input.threadId,
      createdAt,
    };
  }

  async interruptTurn(input: {
    threadId: string;
    turnId?: string;
    signal?: AbortSignal;
  }): Promise<number> {
    return this.dispatch(
      {
        type: "thread.turn.interrupt",
        commandId: this.idFactory(),
        threadId: input.threadId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: this.now().toISOString(),
      },
      input.signal,
    );
  }

  async waitForTurnTerminal(input: {
    threadId: string;
    minimumSequence: number;
    messageId?: string;
    requestedAt?: string;
    timeoutMs?: number;
    absoluteTimeoutMs?: number;
    pollIntervalMs?: number;
    signal?: AbortSignal;
    onSnapshot?(snapshot: T3ThreadSnapshot): void | Promise<void>;
  }): Promise<T3ThreadSnapshot> {
    const timeoutMs = input.timeoutMs ?? 30 * 60_000;
    const absoluteTimeoutMs = input.absoluteTimeoutMs ?? timeoutMs;
    const startedAt = this.now().getTime();
    const absoluteDeadline = startedAt + absoluteTimeoutMs;
    let progressDeadline = startedAt + timeoutMs;
    let latestSequence = -1;
    const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    while (
      this.now().getTime() < progressDeadline &&
      this.now().getTime() < absoluteDeadline
    ) {
      if (input.signal?.aborted) {
        throw new T3GatewayError(
          "aborted",
          "wait for turn",
          "T3 wait for turn was aborted",
        );
      }
      const remainingMs = Math.max(
        1,
        Math.min(progressDeadline, absoluteDeadline) - this.now().getTime(),
      );
      const deadlineSignal = AbortSignal.timeout(remainingMs);
      const snapshotSignal = input.signal
        ? AbortSignal.any([input.signal, deadlineSignal])
        : deadlineSignal;
      let snapshot: T3ThreadSnapshot;
      try {
        snapshot = await this.threadSnapshot(input.threadId, snapshotSignal);
      } catch (error) {
        if (
          !input.signal?.aborted &&
          (deadlineSignal.aborted ||
            this.now().getTime() >= progressDeadline ||
            this.now().getTime() >= absoluteDeadline)
        ) {
          break;
        }
        throw error;
      }
      if (
        this.now().getTime() >= progressDeadline ||
        this.now().getTime() >= absoluteDeadline
      ) {
        break;
      }
      if (snapshot.snapshotSequence > latestSequence) {
        latestSequence = snapshot.snapshotSequence;
        progressDeadline = this.now().getTime() + timeoutMs;
      }
      let snapshotDeliveryTimedOut = false;
      if (input.onSnapshot) {
        const deliveryDeadlineSignal = AbortSignal.timeout(Math.max(
          1,
          Math.min(progressDeadline, absoluteDeadline) - this.now().getTime(),
        ));
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            deliveryDeadlineSignal.removeEventListener("abort", onDeadline);
            input.signal?.removeEventListener("abort", onAbort);
          };
          const onDeadline = () => {
            snapshotDeliveryTimedOut = true;
            cleanup();
            resolve();
          };
          const onAbort = () => {
            cleanup();
            reject(new T3GatewayError(
              "aborted",
              "wait for turn",
              "T3 wait for turn was aborted",
            ));
          };
          deliveryDeadlineSignal.addEventListener("abort", onDeadline, {
            once: true,
          });
          input.signal?.addEventListener("abort", onAbort, { once: true });
          Promise.resolve(input.onSnapshot?.(snapshot)).then(
            () => {
              cleanup();
              resolve();
            },
            (error: unknown) => {
              cleanup();
              reject(error);
            },
          );
        });
      }
      if (
        snapshotDeliveryTimedOut ||
        this.now().getTime() >= progressDeadline ||
        this.now().getTime() >= absoluteDeadline
      ) {
        break;
      }
      const requestedMessage = input.messageId
        ? snapshot.thread.messages.find(
            (message) =>
              message.id === input.messageId && message.role === "user",
          )
        : undefined;
      const latestTurn = snapshot.thread.latestTurn;
      // T3 normalizes the persisted user-message timestamp on the server. Use
      // that value once available so a few milliseconds of host/Modal clock
      // skew cannot keep a completed turn looking perpetually in-flight. A
      // steer is persisted after the active turn's requestedAt, so correlate
      // it against the full terminal turn window rather than only its start.
      // A message appended after a prior turn completed still cannot match
      // that stale terminal turn.
      const correlationTimestamp =
        requestedMessage?.createdAt ?? input.requestedAt;
      const correlationTime = correlationTimestamp
        ? Date.parse(correlationTimestamp)
        : undefined;
      const requestedTime = latestTurn
        ? Date.parse(latestTurn.requestedAt)
        : undefined;
      const completedTime = latestTurn?.completedAt
        ? Date.parse(latestTurn.completedAt)
        : undefined;
      const latestTurnCoversRequest =
        correlationTime === undefined ||
        (requestedTime !== undefined &&
          Number.isFinite(requestedTime) &&
          requestedTime >= correlationTime) ||
        (completedTime !== undefined &&
          Number.isFinite(completedTime) &&
          completedTime >= correlationTime);
      const matchesRequestedTurn =
        (!input.messageId || requestedMessage !== undefined) &&
        latestTurn !== null &&
        latestTurnCoversRequest &&
        (requestedMessage?.turnId == null ||
          requestedMessage.turnId === latestTurn?.turnId);
      const startFailure = preTurnStartFailure(
        snapshot,
        input.messageId,
      );
      if (
        snapshot.snapshotSequence >= input.minimumSequence &&
        ((matchesRequestedTurn && terminalTurn(snapshot.thread)) ||
          startFailure !== undefined)
      ) {
        return snapshot;
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(
            new T3GatewayError(
              "aborted",
              "wait for turn",
              "T3 wait for turn was aborted",
            ),
          );
        };
        const remainingPollMs = Math.max(
          1,
          Math.min(progressDeadline, absoluteDeadline) - this.now().getTime(),
        );
        const timer = setTimeout(() => {
          input.signal?.removeEventListener("abort", onAbort);
          resolve();
        }, Math.min(pollIntervalMs, remainingPollMs));
        input.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    const absoluteExpired =
      absoluteDeadline <= progressDeadline ||
      this.now().getTime() >= absoluteDeadline;
    log.error(
      {
        threadId: input.threadId,
        messageId: input.messageId,
        deadline: absoluteExpired ? "absolute" : "progress",
        elapsedMs: this.now().getTime() - startedAt,
        absoluteTimeoutMs,
        progressTimeoutMs: timeoutMs,
        minimumSequence: input.minimumSequence,
      },
      "t3 turn wait timed out",
    );
    throw new T3GatewayError(
      "timeout",
      "wait for turn",
      absoluteExpired
        ? `T3 turn exceeded its absolute deadline of ${absoluteTimeoutMs}ms`
        : `T3 turn made no durable progress for ${timeoutMs}ms`,
    );
  }

  async mintPairingCredential(input: {
    label: string;
    scopes?: ReadonlyArray<string>;
    signal?: AbortSignal;
  }): Promise<{
    id: string;
    credential: string;
    label?: string;
    expiresAt: string;
  }> {
    return this.request(
      "pairing credential creation",
      "/api/auth/pairing-token",
      {
        method: "POST",
        body: {
          label: input.label,
          ...(input.scopes ? { scopes: input.scopes } : {}),
        },
        schema: pairingCredentialSchema,
        signal: input.signal,
      },
    );
  }
}

export async function exchangeT3PairingToken(input: {
  baseUrl: string;
  pairingToken: string;
  scopes?: ReadonlyArray<string>;
  fetch?: Fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{
  client: T3Client;
  /** Sensitive: persist only in the isolated environment or a secret store. */
  accessToken: string;
  expiresIn: number;
  scopes: ReadonlyArray<string>;
}> {
  const client = new T3Client(input.baseUrl, "", {
    fetch: input.fetch,
    timeoutMs: input.timeoutMs,
  });
  const form = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE_GRANT,
    subject_token: input.pairingToken,
    subject_token_type: ENVIRONMENT_BOOTSTRAP_TOKEN_TYPE,
    requested_token_type: ACCESS_TOKEN_TYPE,
    client_label: "Compadre gateway",
    client_device_type: "bot",
  });
  if (input.scopes) form.set("scope", input.scopes.join(" "));
  const result = await client["request"]<z.infer<typeof accessTokenSchema>>(
    "pairing token exchange",
    "/oauth/token",
    {
      method: "POST",
      form,
      schema: accessTokenSchema,
      signal: input.signal,
      authenticated: false,
    },
  );
  return {
    client: new T3Client(input.baseUrl, result.access_token, {
      fetch: input.fetch,
      timeoutMs: input.timeoutMs,
    }),
    accessToken: result.access_token,
    expiresIn: result.expires_in,
    scopes: result.scope.split(/\s+/).filter(Boolean),
  };
}
