import type { AgentProvider } from "./protocol.js";

export interface HarnessThreadState {
  worktreeId: string;
  sessions: Partial<Record<AgentProvider, string>>;
  transcript: HarnessTranscriptMessage[];
  lastProvider?: AgentProvider;
  lastAccessedAt: number;
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
  deleteStale(maxAgeMs: number): Promise<HarnessThreadState[]>;
  worktreeIds(): Promise<Set<string>>;
}

export class InMemoryHarnessThreadStore implements HarnessThreadStore {
  private readonly states = new Map<string, HarnessThreadState>();

  constructor(private readonly now: () => number = Date.now) {}

  async getOrCreate(
    threadId: string,
    createWorktreeId: () => string
  ): Promise<HarnessThreadState> {
    const existing = this.states.get(threadId);
    if (existing) {
      existing.lastAccessedAt = this.now();
      return existing;
    }

    const state: HarnessThreadState = {
      worktreeId: createWorktreeId(),
      sessions: {},
      transcript: [],
      lastAccessedAt: this.now(),
    };
    this.states.set(threadId, state);
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
      lastAccessedAt: this.now(),
    };
    state.sessions[provider] = sessionId;
    state.lastProvider = provider;
    state.lastAccessedAt = this.now();
    this.states.set(threadId, state);
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
      lastAccessedAt: this.now(),
    };
    state.transcript.push(
      { role: "user", content: userPrompt },
      { role: "assistant", content: assistantText }
    );
    if (state.transcript.length > 200) {
      state.transcript.splice(0, state.transcript.length - 200);
    }
    state.lastAccessedAt = this.now();
    this.states.set(threadId, state);
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

  async deleteStale(maxAgeMs: number): Promise<HarnessThreadState[]> {
    const cutoff = this.now() - maxAgeMs;
    const deleted: HarnessThreadState[] = [];
    for (const [threadId, state] of this.states) {
      if (state.lastAccessedAt <= cutoff) {
        this.states.delete(threadId);
        deleted.push(state);
      }
    }
    return deleted;
  }

  async worktreeIds(): Promise<Set<string>> {
    return new Set([...this.states.values()].map((state) => state.worktreeId));
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
