import { randomUUID } from "node:crypto";
import type {
  T3Client,
  T3ModelSelection,
  T3ThreadSnapshot,
  T3TurnDispatch,
} from "./client.js";
import {
  T3ThreadBindingStore,
  type T3ThreadBinding,
} from "../services/t3-thread-bindings.js";

export interface T3CommandClient {
  readonly baseUrl: string;
  startNewThread(input: {
    threadId?: string;
    projectId: string;
    title: string;
    text: string;
    modelSelection: T3ModelSelection;
    signal?: AbortSignal;
  }): Promise<T3TurnDispatch>;
  startTurn(input: {
    threadId: string;
    text: string;
    modelSelection: T3ModelSelection;
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
  }): Promise<T3ThreadSnapshot>;
}

export interface T3EnvironmentConnection {
  sandboxId: string;
  projectId: string;
  client: T3CommandClient;
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
  ) {}

  async send(input: {
    canonicalThreadId: string;
    title: string;
    text: string;
    modelSelection: T3ModelSelection;
    signal?: AbortSignal;
  }): Promise<T3GatewayTurn> {
    const providerInstanceId = input.modelSelection.instanceId;
    const existing = await this.bindings.get(
      input.canonicalThreadId,
      providerInstanceId,
    );
    if (existing) {
      const environment = await this.environments.reconnect(existing);
      const dispatch = await environment.client.startTurn({
        threadId: existing.t3ThreadId,
        text: input.text,
        modelSelection: input.modelSelection,
        signal: input.signal,
      });
      const updated: T3ThreadBinding = {
        ...existing,
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

  async cancel(input: {
    canonicalThreadId: string;
    providerInstanceId: string;
    turnId?: string;
    signal?: AbortSignal;
  }): Promise<number | null> {
    const binding = await this.bindings.get(
      input.canonicalThreadId,
      input.providerInstanceId,
    );
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
  }): Promise<T3ThreadSnapshot> {
    const environment = await this.environments.reconnect(input.turn.binding);
    return environment.client.waitForTurnTerminal({
      threadId: input.turn.binding.t3ThreadId,
      minimumSequence: input.turn.dispatch.sequence,
      messageId: input.turn.dispatch.messageId,
      requestedAt: input.turn.dispatch.createdAt,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
  }
}

export function asT3CommandClient(client: T3Client): T3CommandClient {
  return client;
}
