import { z } from "zod";
import { T3EnvironmentUnavailableError, type T3Gateway } from "./gateway.js";
import type { WorkerTerminalRpc } from "./terminal-rpc.js";

const terminalId = z.string().trim().min(1).max(128);
const session = z.object({ threadId: z.string().min(1).max(200), terminalId });
const size = {
  cols: z.number().int().min(1).max(1000).optional(),
  rows: z.number().int().min(1).max(500).optional(),
};
export const terminalRequestSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("open"),
    input: session.extend({
      ...size,
      startWorker: z.boolean().optional(),
      creation: z
        .object({
          title: z.string().min(1).max(200),
          modelSelection: z.object({
            instanceId: z.string().min(1).max(128),
            model: z.string().min(1).max(200),
          }),
        })
        .optional(),
    }),
  }),
  z.object({ operation: z.literal("attach"), input: session.extend(size) }),
  z.object({ operation: z.literal("connection"), input: session.extend(size) }),
  z.object({
    operation: z.literal("write"),
    input: session.extend({ data: z.string().min(1).max(65536) }),
  }),
  z.object({ operation: z.literal("resize"), input: session.extend(size) }),
  z.object({ operation: z.literal("clear"), input: session }),
  z.object({ operation: z.literal("restart"), input: session.extend(size) }),
  z.object({
    operation: z.literal("close"),
    input: session.extend({
      terminalId: terminalId.optional(),
      deleteHistory: z.boolean().optional(),
    }),
  }),
]);
export type TerminalRequest = z.infer<typeof terminalRequestSchema>;
export class TerminalAccessError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Connection = {
  rpc: WorkerTerminalRpc;
  nativeThreadId: string;
  cwd: string;
  sandboxId: string;
  baseUrl: string;
};
/** Only open(startWorker=true) may call ensureWorkerRunning. All other paths attach or fail. */
export class T3TerminalService {
  private connections = new Map<string, Connection>();
  constructor(
    private gateway: Pick<T3Gateway, "attachWorker" | "ensureWorkerRunning"> &
      Partial<Pick<T3Gateway, "checkpointWorkspace">>,
  ) {}

  async connect(request: TerminalRequest): Promise<Connection> {
    const threadId = request.input.threadId;
    const wake = request.operation === "open" && request.input.startWorker === true;
    const cached = this.connections.get(threadId);
    if (!wake && cached && !cached.rpc.isClosed) return cached;
    for (const [id, connection] of this.connections)
      if (connection.rpc.isClosed) this.connections.delete(id);
    let worker;
    try {
      worker = await (wake
        ? this.gateway.ensureWorkerRunning(
            threadId,
            request.operation === "open" ? request.input.creation : undefined,
          )
        : this.gateway.attachWorker(threadId));
    } catch (error) {
      if (error instanceof T3EnvironmentUnavailableError)
        throw new TerminalAccessError(
          409,
          "Workspace is stopped. Select Start workspace to start it.",
        );
      throw new TerminalAccessError(503, "Could not connect to the workspace. Try again.");
    }
    if (!worker)
      throw new TerminalAccessError(
        404,
        "Workspace is not running. Select Start workspace to start it.",
      );
    // Concurrent pane opens share one live connection after the await above.
    const current = this.connections.get(threadId);
    if (current && !current.rpc.isClosed && current.sandboxId === worker.binding.sandboxId)
      return current;
    current?.rpc.close();
    if (!worker.environment.client.createTerminalRpc || !worker.environment.client.snapshot)
      throw new TerminalAccessError(503, "This worker does not support terminals yet.");
    const snapshot = await worker.environment.client.threadSnapshot(worker.binding.t3ThreadId);
    const projects = await worker.environment.client.snapshot();
    const cwd =
      typeof snapshot.thread.worktreePath === "string"
        ? snapshot.thread.worktreePath
        : projects.projects.find((project) => project.id === snapshot.thread.projectId)
            ?.workspaceRoot;
    if (!cwd) throw new TerminalAccessError(503, "Workspace directory is unavailable.");
    // Recheck after directory resolution, which can race another pane's attach.
    const latest = this.connections.get(threadId);
    if (latest && !latest.rpc.isClosed && latest.sandboxId === worker.binding.sandboxId)
      return latest;
    const connection = {
      rpc: worker.environment.client.createTerminalRpc(),
      cwd,
      nativeThreadId: worker.binding.t3ThreadId,
      sandboxId: worker.binding.sandboxId,
      baseUrl: worker.binding.baseUrl,
    };
    this.connections.set(threadId, connection);
    return connection;
  }

  async *execute(request: TerminalRequest, connection: Connection, signal: AbortSignal) {
    const { threadId, ...input } = request.input;
    // CWD and environment are worker-owned; never forward central paths or credentials.
    const payload = {
      ...input,
      startWorker: undefined,
      creation: undefined,
      threadId: connection.nativeThreadId,
      ...(["open", "attach", "restart", "connection"].includes(request.operation)
        ? { cwd: connection.cwd, worktreePath: null }
        : {}),
    };
    if (request.operation === "connection") {
      // Older workers retain the relay. Never send an unknown RPC to their connection.
      let supported = false;
      for await (const config of connection.rpc.request("server.getConfig", {}, signal)) {
        const parsed = z.object({ environment: z.object({ capabilities: z.object({ directTerminals: z.boolean().optional() }) }) }).safeParse(config);
        supported = parsed.success && parsed.data.environment.capabilities.directTerminals === true;
      }
      if (!supported) { yield null; return; }
      for await (const value of connection.rpc.request("terminal.connection", payload, signal)) {
        const grant = z.object({url: z.literal("/terminal/direct"), ticket: z.string(), expiresAt: z.string()}).parse(value);
        const url = new URL(grant.url, connection.baseUrl);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        yield { ...grant, url: url.toString() };
      }
      return;
    }
    for await (const value of connection.rpc.request(
      `terminal.${request.operation}`,
      payload,
      signal,
    )) {
      if (!value || typeof value !== "object") {
        yield value;
        continue;
      }
      const record = value as Record<string, unknown>;
      yield {
        ...record,
        ...(typeof record.threadId === "string" ? { threadId } : {}),
        ...(record.snapshot && typeof record.snapshot === "object"
          ? { snapshot: { ...record.snapshot, threadId } }
          : {}),
      };
    }
    if (request.operation === "close") await this.gateway.checkpointWorkspace?.(threadId);
  }

  close() {
    for (const connection of this.connections.values()) connection.rpc.close();
    this.connections.clear();
  }
}
