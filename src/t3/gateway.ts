import { randomUUID } from "node:crypto";
import { InMemoryLockStore, type LockStore } from "./storage.js";
import type {
  T3Client,
  T3InputFile,
  T3ModelSelection,
  T3ThreadSnapshot,
  T3TurnDispatch,
} from "./client.js";
import {
  T3ThreadBindingStore,
  type T3ThreadBinding,
} from "../services/t3-thread-bindings.js";
import { T3ThreadSnapshotStore } from "../services/t3-thread-snapshots.js";
import type { SandboxHandle } from "@tanstack/ai-sandbox";
import {
  collectT3OutputArtifacts,
  type T3OutputArtifact,
} from "./output-artifacts.js";

export interface T3CommandClient {
  readonly baseUrl: string;
  startNewThread(input: {
    threadId?: string;
    projectId: string;
    title: string;
    text: string;
    displayText?: string;
    modelSelection: T3ModelSelection;
    inputFiles?: ReadonlyArray<T3InputFile>;
    signal?: AbortSignal;
  }): Promise<T3TurnDispatch>;
  startTurn(input: {
    threadId: string;
    text: string;
    displayText?: string;
    modelSelection: T3ModelSelection;
    inputFiles?: ReadonlyArray<T3InputFile>;
    signal?: AbortSignal;
  }): Promise<T3TurnDispatch>;
  interruptTurn(input: {
    threadId: string;
    turnId?: string;
    signal?: AbortSignal;
  }): Promise<number>;
  waitForTurnTerminal(input: {
    threadId: string;
    minimumSequence: number;
    messageId?: string;
    requestedAt?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    onSnapshot?(snapshot: T3ThreadSnapshot): void | Promise<void>;
  }): Promise<T3ThreadSnapshot>;
  threadSnapshot(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<T3ThreadSnapshot>;
  mintPairingCredential(input: {
    label: string;
    scopes?: ReadonlyArray<string>;
    signal?: AbortSignal;
  }): Promise<{ id: string; credential: string; expiresAt: string }>;
}

export interface T3EnvironmentConnection {
  sandboxId: string;
  projectId: string;
  client: T3CommandClient;
  sandbox?: SandboxHandle;
}

export interface T3EnvironmentConnectionManager {
  provision(input: {
    canonicalThreadId: string;
    providerInstanceId: string;
  }): Promise<T3EnvironmentConnection>;
  reconnect(binding: T3ThreadBinding): Promise<T3EnvironmentConnection>;
  discard?(connection: T3EnvironmentConnection): Promise<void>;
}

export interface T3GatewayTurn {
  binding: T3ThreadBinding;
  dispatch: T3TurnDispatch;
}

export interface T3GatewayTextGeneration {
  dispatch: T3TurnDispatch;
  snapshot: T3ThreadSnapshot;
}

const DEFAULT_T3_HOSTED_APP_URL = "https://app.t3.codes";

export function buildT3HostedThreadUrl(input: {
  hostedAppUrl: string;
  environmentUrl: string;
  pairingCredential: string;
  threadId: string;
  label: string;
}): string {
  const url = new URL("/pair", input.hostedAppUrl);
  url.searchParams.set("host", input.environmentUrl);
  url.searchParams.set("label", input.label);
  url.searchParams.set("threadId", input.threadId);
  url.hash = new URLSearchParams([["token", input.pairingCredential]]).toString();
  return url.toString();
}

/**
 * Provider-neutral entry point used by Slack, HTTP, and the hosted UI.
 * T3 remains responsible for native Codex/Claude lifecycle and transcript
 * projection; this class owns only external-thread routing.
 */
export class T3Gateway {
  constructor(
    private readonly bindings: T3ThreadBindingStore,
    private readonly environments: T3EnvironmentConnectionManager,
    private readonly idFactory: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
    private readonly locks: LockStore = new InMemoryLockStore(),
    private readonly hostedAppUrl: string =
      process.env.COMPADRE_T3_HOSTED_APP_URL?.trim() ||
      DEFAULT_T3_HOSTED_APP_URL,
    private readonly snapshots?: T3ThreadSnapshotStore,
  ) {}

  private lockKey(canonicalThreadId: string) {
    return `compadre:t3-environment:${canonicalThreadId}`;
  }

  /**
   * Runs provider-backed metadata generation outside the durable user thread
   * directory. The temporary T3 environment is always discarded, so title,
   * branch, commit, and PR generation cannot appear as user conversations.
   */
  async generateText(input: {
    prompt: string;
    modelSelection: T3ModelSelection;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<T3GatewayTextGeneration> {
    if (!this.environments.discard) {
      throw new Error("T3 text generation requires disposable environments");
    }
    const generationId = this.idFactory();
    const environment = await this.environments.provision({
      canonicalThreadId: `internal-text-generation:${generationId}`,
      providerInstanceId: input.modelSelection.instanceId,
    });
    try {
      const threadId = this.idFactory();
      const dispatch = await environment.client.startNewThread({
        threadId,
        projectId: environment.projectId,
        title: "Internal text generation",
        text: input.prompt,
        modelSelection: input.modelSelection,
        signal: input.signal,
      });
      const snapshot = await environment.client.waitForTurnTerminal({
        threadId,
        minimumSequence: dispatch.sequence,
        messageId: dispatch.messageId,
        requestedAt: dispatch.createdAt,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
      });
      const state = snapshot.thread.latestTurn?.state;
      if (state === "error") {
        throw new Error(
          snapshot.thread.session?.lastError || "T3 text generation failed",
        );
      }
      if (state === "interrupted") {
        throw new Error("T3 text generation was interrupted");
      }
      return { dispatch, snapshot };
    } finally {
      await this.environments.discard(environment);
    }
  }

  async send(input: {
    canonicalThreadId: string;
    title: string;
    text: string;
    displayText?: string;
    modelSelection: T3ModelSelection;
    inputFiles?: ReadonlyArray<T3InputFile>;
    signal?: AbortSignal;
  }): Promise<T3GatewayTurn> {
    return this.locks.withLock(
      this.lockKey(input.canonicalThreadId),
      async (lockSignal) => {
        if (lockSignal.aborted) throw lockSignal.reason;
        return this.sendUnlocked(input);
      },
    );
  }

  private async sendUnlocked(input: {
    canonicalThreadId: string;
    title: string;
    text: string;
    displayText?: string;
    modelSelection: T3ModelSelection;
    inputFiles?: ReadonlyArray<T3InputFile>;
    signal?: AbortSignal;
  }): Promise<T3GatewayTurn> {
    const providerInstanceId = input.modelSelection.instanceId;
    const existing = await this.bindings.get(input.canonicalThreadId);
    if (existing) {
      if (existing.providerInstanceId !== providerInstanceId) {
        throw new Error(
          `This T3 thread is already using ${existing.providerInstanceId}; start a new thread to use ${providerInstanceId}.`,
        );
      }
      const environment = await this.environments.reconnect(existing);
      const dispatch = await environment.client.startTurn({
        threadId: existing.t3ThreadId,
        text: input.text,
        displayText: input.displayText,
        modelSelection: input.modelSelection,
        inputFiles: input.inputFiles,
        signal: input.signal,
      });
      const updated: T3ThreadBinding = {
        ...existing,
        title: existing.title ?? input.title,
        status: "working",
        modelSelection: input.modelSelection,
        updatedAt: this.now().toISOString(),
      };
      await this.bindings.bind(updated);
      return { binding: updated, dispatch };
    }

    const environment = await this.environments.provision({
      canonicalThreadId: input.canonicalThreadId,
      providerInstanceId,
    });
    try {
      const t3ThreadId = this.idFactory();
      const dispatch = await environment.client.startNewThread({
        threadId: t3ThreadId,
        projectId: environment.projectId,
        title: input.title,
        text: input.text,
        displayText: input.displayText,
        modelSelection: input.modelSelection,
        signal: input.signal,
      });
      const timestamp = this.now().toISOString();
      const binding: T3ThreadBinding = {
        canonicalThreadId: input.canonicalThreadId,
        providerInstanceId,
        t3ThreadId,
        projectId: environment.projectId,
        sandboxId: environment.sandboxId,
        baseUrl: environment.client.baseUrl,
        modelSelection: input.modelSelection,
        title: input.title,
        status: "working",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await this.bindings.bind(binding);
      return { binding, dispatch };
    } catch (error) {
      await this.environments.discard?.(environment).catch(() => undefined);
      throw error;
    }
  }

  list(): Promise<T3ThreadBinding[]> {
    return this.bindings.list();
  }

  async snapshot(input: {
    canonicalThreadId: string;
    providerInstanceId: string;
    signal?: AbortSignal;
  }): Promise<{
    binding: T3ThreadBinding;
    snapshot: T3ThreadSnapshot;
    source: "central" | "worker";
  } | null> {
    const binding = await this.bindings.get(input.canonicalThreadId);
    if (!binding) return null;
    const archived = await this.snapshots?.get(input.canonicalThreadId);
    if (archived && binding.status !== "working") {
      return { binding, snapshot: archived.snapshot, source: "central" };
    }
    try {
      const environment = await this.environments.reconnect(binding);
      const snapshot = await environment.client.threadSnapshot(
        binding.t3ThreadId,
        input.signal,
      );
      await this.snapshots?.save(binding, snapshot);
      const latestState = snapshot.thread.latestTurn?.state;
      const status =
        latestState === "running"
          ? "working"
          : latestState === "error"
            ? "error"
            : latestState === "interrupted"
              ? "interrupted"
              : "ready";
      const updated: T3ThreadBinding = {
        ...binding,
        title: snapshot.thread.title || binding.title,
        modelSelection: snapshot.thread.modelSelection,
        status,
        // Reading a selected transcript is not new thread activity. Keeping
        // this stable lets the central directory signal real cross-surface
        // changes without creating a snapshot/poll feedback loop.
        updatedAt: binding.updatedAt,
        baseUrl: environment.client.baseUrl,
      };
      await this.bindings.bind(updated);
      return { binding: updated, snapshot, source: "worker" };
    } catch (error) {
      const unavailable: T3ThreadBinding = {
        ...binding,
        status: "unavailable",
        updatedAt: this.now().toISOString(),
      };
      await this.bindings.bind(unavailable).catch(() => undefined);
      if (archived) {
        return {
          binding: unavailable,
          snapshot: archived.snapshot,
          source: "central",
        };
      }
      throw error;
    }
  }

  async open(input: {
    canonicalThreadId: string;
    providerInstanceId: string;
    signal?: AbortSignal;
  }): Promise<{ binding: T3ThreadBinding; pairingUrl: string } | null> {
    const binding = await this.bindings.get(input.canonicalThreadId);
    if (!binding) return null;
    const environment = await this.environments.reconnect(binding);
    const pairing = await environment.client.mintPairingCredential({
      label: `Compadre thread ${binding.canonicalThreadId}`,
      signal: input.signal,
    });
    return {
      binding,
      pairingUrl: buildT3HostedThreadUrl({
        hostedAppUrl: this.hostedAppUrl,
        environmentUrl: environment.client.baseUrl,
        pairingCredential: pairing.credential,
        threadId: binding.t3ThreadId,
        label: binding.title ?? `Compadre thread ${binding.canonicalThreadId}`,
      }),
    };
  }

  async cancel(input: {
    canonicalThreadId: string;
    providerInstanceId: string;
    turnId?: string;
    signal?: AbortSignal;
  }): Promise<number | null> {
    const binding = await this.bindings.get(input.canonicalThreadId);
    if (!binding) return null;
    const environment = await this.environments.reconnect(binding);
    return environment.client.interruptTurn({
      threadId: binding.t3ThreadId,
      turnId: input.turnId,
      signal: input.signal,
    });
  }

  async waitForTerminal(input: {
    turn: T3GatewayTurn;
    timeoutMs?: number;
    signal?: AbortSignal;
    onSnapshot?(snapshot: T3ThreadSnapshot): void | Promise<void>;
  }): Promise<T3ThreadSnapshot> {
    const environment = await this.environments.reconnect(input.turn.binding);
    const snapshot = await environment.client.waitForTurnTerminal({
      threadId: input.turn.binding.t3ThreadId,
      minimumSequence: input.turn.dispatch.sequence,
      messageId: input.turn.dispatch.messageId,
      requestedAt: input.turn.dispatch.createdAt,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      onSnapshot: async (nextSnapshot) => {
        await this.snapshots?.save(input.turn.binding, nextSnapshot);
        await input.onSnapshot?.(nextSnapshot);
      },
    });
    await this.snapshots?.save(input.turn.binding, snapshot);
    const latestState = snapshot.thread.latestTurn?.state;
    await this.bindings.bind({
      ...input.turn.binding,
      title: snapshot.thread.title || input.turn.binding.title,
      modelSelection: snapshot.thread.modelSelection,
      status:
        latestState === "error"
          ? "error"
          : latestState === "interrupted"
            ? "interrupted"
            : "ready",
      updatedAt: this.now().toISOString(),
    });
    return snapshot;
  }

  async collectOutputArtifacts(
    turn: T3GatewayTurn,
    publish: (artifact: T3OutputArtifact) => Promise<void>,
  ): Promise<{ published: Array<{ path: string; digest: string }>; failures: string[] }> {
    const environment = await this.environments.reconnect(turn.binding);
    if (!environment.sandbox) {
      return { published: [], failures: ["The T3 sandbox filesystem is unavailable."] };
    }
    return collectT3OutputArtifacts(environment.sandbox, publish);
  }
}

export function asT3CommandClient(client: T3Client): T3CommandClient {
  return client;
}
