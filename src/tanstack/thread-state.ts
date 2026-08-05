import type { AgentProvider } from "./protocol.js";

export interface HarnessThreadState {
  worktreeId: string;
  sessions: Partial<Record<AgentProvider, string>>;
  transcript: HarnessTranscriptMessage[];
  lastProvider?: AgentProvider;
}

export interface HarnessTranscriptMessage {
  role: "user" | "assistant";
  content: string;
}

/** Persistence boundary; a Postgres implementation can replace this later. */
export interface HarnessThreadStore {
  getOrCreate(
    threadId: string,
    createWorktreeId: () => string
  ): Promise<HarnessThreadState>;
  recordSession(
    threadId: string,
    provider: AgentProvider,
    sessionId: string,
    worktreeId: string
  ): Promise<void>;
  recordTurn(
    threadId: string,
    userPrompt: string,
    assistantText: string,
    worktreeId: string
  ): Promise<void>;
  deleteIfUninitialized(
    threadId: string,
    worktreeId: string
  ): Promise<boolean>;
  delete(threadId: string): Promise<HarnessThreadState | undefined>;
}

export class InMemoryHarnessThreadStore implements HarnessThreadStore {
  private readonly states = new Map<string, HarnessThreadState>();

  constructor(private readonly maxStates = 5000) {}

  async getOrCreate(
    threadId: string,
    createWorktreeId: () => string
  ): Promise<HarnessThreadState> {
    const existing = this.states.get(threadId);
    if (existing) return existing;

    const state: HarnessThreadState = {
      worktreeId: createWorktreeId(),
      sessions: {},
      transcript: [],
    };
    this.states.set(threadId, state);
    this.prune();
    return state;
  }

  async recordSession(
    threadId: string,
    provider: AgentProvider,
    sessionId: string,
    worktreeId: string
  ): Promise<void> {
    const state = this.states.get(threadId) ?? {
      worktreeId,
      sessions: {},
      transcript: [],
    };
    state.sessions[provider] = sessionId;
    state.lastProvider = provider;
    this.states.set(threadId, state);
    this.prune();
  }

  async recordTurn(
    threadId: string,
    userPrompt: string,
    assistantText: string,
    worktreeId: string
  ): Promise<void> {
    const state = this.states.get(threadId) ?? {
      worktreeId,
      sessions: {},
      transcript: [],
    };
    state.transcript.push(
      { role: "user", content: userPrompt },
      { role: "assistant", content: assistantText }
    );
    if (state.transcript.length > 200) {
      state.transcript.splice(0, state.transcript.length - 200);
    }
    this.states.set(threadId, state);
    this.prune();
  }

  async deleteIfUninitialized(
    threadId: string,
    worktreeId: string
  ): Promise<boolean> {
    const state = this.states.get(threadId);
    if (
      !state ||
      state.worktreeId !== worktreeId ||
      Object.keys(state.sessions).length > 0
    ) {
      return false;
    }
    this.states.delete(threadId);
    return true;
  }

  async delete(threadId: string): Promise<HarnessThreadState | undefined> {
    const state = this.states.get(threadId);
    this.states.delete(threadId);
    return state;
  }

  private prune(): void {
    if (this.states.size <= this.maxStates) return;
    const toDelete = this.states.size - this.maxStates;
    const iterator = this.states.keys();
    for (let index = 0; index < toDelete; index += 1) {
      const key = iterator.next().value;
      if (key !== undefined) this.states.delete(key);
    }
  }
}

export const harnessThreadStore: HarnessThreadStore =
  new InMemoryHarnessThreadStore();

/**
 * Resume only when the previous turn used the same harness. After a provider
 * switch, start a fresh provider session from the full AG-UI transcript so a
 * stale provider-native session cannot omit turns produced by the other agent.
 */
export function resumableHarnessSession(
  state: HarnessThreadState,
  provider: AgentProvider
): string | undefined {
  return state.lastProvider === provider ? state.sessions[provider] : undefined;
}
