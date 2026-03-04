export interface ThreadSession {
  sessionId: string;
  worktreeId: string;
}

const MAX_THREAD_SESSIONS = 5000;
const threadSessions = new Map<string, ThreadSession>();

export function getSession(threadKey: string): ThreadSession | undefined {
  return threadSessions.get(threadKey);
}

export function setSession(threadKey: string, session: ThreadSession): void {
  threadSessions.set(threadKey, session);
  prune();
}

/** Evict oldest entries when the map exceeds the cap. */
function prune() {
  if (threadSessions.size <= MAX_THREAD_SESSIONS) return;
  const toDelete = threadSessions.size - MAX_THREAD_SESSIONS;
  const iter = threadSessions.keys();
  for (let i = 0; i < toDelete; i++) {
    const key = iter.next().value;
    if (key !== undefined) threadSessions.delete(key);
  }
}
