import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  fetchServerSentEvents,
  useChat,
  type UIMessage,
} from "@tanstack/ai-react";
import "./styles.css";

const API_KEY_STORAGE = "compadre.hosted.api-key";
const PROVIDER_STORAGE = "compadre.hosted.provider";

type Provider = "claude-code" | "codex";
type NativeProvider = "codex" | "claudeAgent";
type DirectoryStatus = "working" | "ready" | "interrupted" | "error" | "unavailable";

interface DirectoryThread {
  canonicalThreadId: string;
  providerInstanceId: NativeProvider;
  t3ThreadId: string;
  title: string;
  modelSelection: { instanceId: NativeProvider; model: string };
  status: DirectoryStatus;
  createdAt: string;
  updatedAt: string;
}

interface NativeMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  streaming: boolean;
}

interface NativeSnapshot {
  snapshotSequence: number;
  thread: {
    id: string;
    title: string;
    modelSelection: { instanceId: NativeProvider; model: string };
    latestTurn: { state: "running" | "interrupted" | "completed" | "error" } | null;
    messages: NativeMessage[];
    session: { status: string; lastError: string | null } | null;
  };
}

const MODEL_OPTIONS: Record<NativeProvider, string[]> = {
  codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
  claudeAgent: ["claude-opus-5", "claude-sonnet-4-6", "claude-haiku-4-5"],
};

function threadKey(thread: Pick<DirectoryThread, "providerInstanceId" | "canonicalThreadId">) {
  return `${thread.providerInstanceId}:${thread.canonicalThreadId}`;
}

function selectedFromUrl(): string | null {
  const url = new URL(window.location.href);
  const thread = url.searchParams.get("thread");
  const provider = url.searchParams.get("provider");
  return thread && (provider === "codex" || provider === "claudeAgent")
    ? `${provider}:${thread}`
    : null;
}

function setNativeThreadUrl(thread: DirectoryThread | null): void {
  const url = new URL(window.location.href);
  if (thread) {
    url.searchParams.set("thread", thread.canonicalThreadId);
    url.searchParams.set("provider", thread.providerInstanceId);
  } else {
    url.searchParams.delete("thread");
    url.searchParams.delete("provider");
  }
  window.history.replaceState({}, "", url);
}

async function nativeRequest<T>(apiKey: string, path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

function currentThread(): string {
  const url = new URL(window.location.href);
  return url.searchParams.get("thread") || `web-${crypto.randomUUID()}`;
}

function setCurrentThread(threadId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("thread", threadId);
  window.history.replaceState({}, "", url);
}

function partView(messageId: string, part: UIMessage["parts"][number], index: number) {
  const key = `${messageId}-${index}`;
  if (part.type === "text") {
    return <div className="message-text" key={key}>{part.content}</div>;
  }
  if (part.type === "thinking") {
    return <details className="trace-card" key={key}><summary>Reasoning</summary><pre>{part.content}</pre></details>;
  }
  if (part.type === "tool-call") {
    return <details className="trace-card" key={key}><summary>{part.name} · {part.state}</summary><pre>{part.arguments}</pre></details>;
  }
  if (part.type === "tool-result") {
    const content = typeof part.content === "string" ? part.content : JSON.stringify(part.content, null, 2);
    return <details className="trace-card" key={key}><summary>Tool result · {part.state}</summary><pre>{content}</pre></details>;
  }
  return null;
}

function Message({ message }: { message: UIMessage }) {
  return (
    <article className={`message ${message.role}`}>
      <div className="message-label">{message.role === "user" ? "You" : "Compadre"}</div>
      <div className="message-body">{message.parts.map((part, index) => partView(message.id, part, index))}</div>
    </article>
  );
}

function ChatWorkspace({ apiKey, threadId }: { apiKey: string; threadId: string }) {
  const [provider, setProvider] = useState<Provider>(() =>
    localStorage.getItem(PROVIDER_STORAGE) === "claude-code" ? "claude-code" : "codex",
  );
  const [draft, setDraft] = useState("");
  const [channelId, setChannelId] = useState("");
  const [threadTs, setThreadTs] = useState(threadId.match(/^\d+\.\d+$/) ? threadId : "");
  const [linkStatus, setLinkStatus] = useState("");
  const transcriptRef = useRef<HTMLElement>(null);

  const connection = useMemo(
    () => fetchServerSentEvents("/hosted/chat", {
      headers: { Authorization: `Bearer ${apiKey}` },
      body: { provider },
    }),
    [apiKey, provider],
  );
  const chat = useChat({ threadId, connection, persistence: true });

  useEffect(() => {
    localStorage.setItem(PROVIDER_STORAGE, provider);
  }, [provider]);
  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTo({ top: transcript.scrollHeight, behavior: "smooth" });
  }, [chat.messages, chat.isLoading]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const message = draft.trim();
    if (!message) return;
    setDraft("");
    await chat.sendMessage(message);
  }

  async function linkSlack(event: React.FormEvent) {
    event.preventDefault();
    setLinkStatus("Linking…");
    const response = await fetch(`/hosted/threads/${encodeURIComponent(threadId)}/slack`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channelId, threadTs }),
    });
    setLinkStatus(response.ok ? "Linked. New web turns will also appear in Slack." : `Link failed (${response.status}).`);
  }

  return (
    <div className="workspace">
      <aside className="sidebar">
        <div>
          <div className="eyebrow">Experimental surface</div>
          <h1>Compadre</h1>
          <p className="muted">One durable conversation, available from Slack or the browser.</p>
        </div>
        <div className="sidebar-section">
          <span className="field-label">Agent</span>
          <div className="segmented">
            <button className={provider === "codex" ? "active" : ""} onClick={() => setProvider("codex")}>Codex</button>
            <button className={provider === "claude-code" ? "active" : ""} onClick={() => setProvider("claude-code")}>Claude</button>
          </div>
        </div>
        <form className="sidebar-section slack-link" onSubmit={linkSlack}>
          <span className="field-label">Mirror to Slack</span>
          <input value={channelId} onChange={(event) => setChannelId(event.target.value)} placeholder="Channel ID · C012…" />
          <input value={threadTs} onChange={(event) => setThreadTs(event.target.value)} placeholder="Thread timestamp" />
          <button className="secondary" disabled={!channelId.trim() || !threadTs.trim()}>Link thread</button>
          {linkStatus && <small>{linkStatus}</small>}
        </form>
        <div className="sidebar-footer"><span className={`status-dot ${chat.error ? "error" : chat.isLoading ? "busy" : ""}`} />{chat.error ? "Connection error" : chat.isLoading ? "Agent is working" : "Ready"}</div>
      </aside>
      <main className="chat-panel">
        <header className="topbar">
          <div><span className="field-label">Thread</span><strong>{threadId}</strong></div>
          <span className="status-copy">{chat.runId ? `run ${chat.runId.slice(0, 8)}` : chat.connectionStatus}</span>
        </header>
        <section className="transcript" ref={transcriptRef}>
          {chat.messages.length === 0 && !chat.isLoading ? (
            <div className="empty-state"><div className="spark">✦</div><h2>What should we build?</h2><p>Ask Compadre to inspect, change, test, or explain the repository connected to this deployment.</p></div>
          ) : chat.messages.map((message) => <Message message={message} key={message.id} />)}
          {chat.error && <div className="error-banner">{chat.error.message}</div>}
        </section>
        <form className="composer" onSubmit={submit}>
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }} placeholder="Message Compadre…" rows={3} />
          <div className="composer-footer"><span>Enter to send · Shift+Enter for a new line</span>{chat.isLoading ? <button type="button" className="stop" onClick={chat.stop}>Stop</button> : <button disabled={!draft.trim()}>Send</button>}</div>
        </form>
      </main>
    </div>
  );
}

function NativeT3Workspace({ apiKey, onDisconnect }: { apiKey: string; onDisconnect(): void }) {
  const [threads, setThreads] = useState<DirectoryThread[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(selectedFromUrl);
  const [snapshot, setSnapshot] = useState<NativeSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [title, setTitle] = useState("New thread");
  const [provider, setProvider] = useState<NativeProvider>("codex");
  const [model, setModel] = useState(MODEL_OPTIONS.codex[0]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const transcriptRef = useRef<HTMLElement>(null);
  const loadedActivityRef = useRef<string | null>(null);
  const selected = threads.find((thread) => threadKey(thread) === selectedKey) ?? null;

  async function loadDirectory() {
    const result = await nativeRequest<{ threads: DirectoryThread[] }>(apiKey, "/hosted/t3/threads");
    setThreads(result.threads);
    setSelectedKey((current) => {
      if (current && result.threads.some((thread) => threadKey(thread) === current)) return current;
      return result.threads[0] ? threadKey(result.threads[0]) : null;
    });
  }

  async function loadSnapshot(thread: DirectoryThread) {
    try {
      const result = await nativeRequest<{ thread: DirectoryThread; snapshot: NativeSnapshot }>(
        apiKey,
        `/hosted/t3/threads/${encodeURIComponent(thread.providerInstanceId)}/${encodeURIComponent(thread.canonicalThreadId)}/snapshot`,
      );
      setSnapshot(result.snapshot);
      setThreads((current) => current.map((item) => threadKey(item) === threadKey(result.thread) ? result.thread : item));
      setError(result.snapshot.thread.session?.lastError || "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load thread");
    }
  }

  useEffect(() => {
    void loadDirectory().catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load threads"));
    const timer = window.setInterval(() => {
      void loadDirectory().catch(() => undefined);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [apiKey]);

  useEffect(() => {
    setNativeThreadUrl(selected);
    setSnapshot(null);
    if (selected) {
      loadedActivityRef.current = selected.updatedAt;
      setProvider(selected.providerInstanceId);
      setModel(selected.modelSelection.model);
      void loadSnapshot(selected);
    }
  }, [selectedKey]);

  useEffect(() => {
    if (!selected || loadedActivityRef.current === selected.updatedAt) return;
    loadedActivityRef.current = selected.updatedAt;
    void loadSnapshot(selected);
  }, [selectedKey, selected?.updatedAt]);

  useEffect(() => {
    if (!selected || selected.status !== "working") return;
    const timer = window.setInterval(() => void loadSnapshot(selected), 1_500);
    return () => window.clearInterval(timer);
  }, [selectedKey, selected?.status, selected?.updatedAt]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTo({ top: transcript.scrollHeight, behavior: "smooth" });
  }, [snapshot?.snapshotSequence, busy]);

  function chooseProvider(next: NativeProvider) {
    setProvider(next);
    setModel(MODEL_OPTIONS[next][0]);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    try {
      if (!selected || creating) {
        const result = await nativeRequest<{ thread: DirectoryThread }>(apiKey, "/hosted/t3/threads", {
          method: "POST",
          body: JSON.stringify({
            title: title.trim() || "New thread",
            text,
            modelSelection: { instanceId: provider, model },
          }),
        });
        setThreads((current) => [result.thread, ...current.filter((item) => threadKey(item) !== threadKey(result.thread))]);
        setSelectedKey(threadKey(result.thread));
        setCreating(false);
      } else {
        const result = await nativeRequest<{ thread: DirectoryThread }>(
          apiKey,
          `/hosted/t3/threads/${encodeURIComponent(selected.providerInstanceId)}/${encodeURIComponent(selected.canonicalThreadId)}/messages`,
          {
            method: "POST",
            body: JSON.stringify({ text, title: selected.title, modelSelection: { instanceId: provider, model } }),
          },
        );
        setThreads((current) => current.map((item) => threadKey(item) === threadKey(result.thread) ? result.thread : item));
        await loadSnapshot(result.thread);
      }
      setDraft("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send message");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!selected) return;
    setBusy(true);
    try {
      await nativeRequest(apiKey, `/hosted/t3/threads/${encodeURIComponent(selected.providerInstanceId)}/${encodeURIComponent(selected.canonicalThreadId)}/cancel`, { method: "POST" });
      await loadSnapshot(selected);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not stop run");
    } finally {
      setBusy(false);
    }
  }

  async function openNative() {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await nativeRequest<{ pairingUrl: string }>(apiKey, `/hosted/t3/threads/${encodeURIComponent(selected.providerInstanceId)}/${encodeURIComponent(selected.canonicalThreadId)}/open`, { method: "POST" });
      window.open(result.pairingUrl, "_blank", "noopener,noreferrer");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open native T3");
    } finally {
      setBusy(false);
    }
  }

  const isWorking = !creating && (selected?.status === "working" || snapshot?.thread.latestTurn?.state === "running");
  const messages = creating ? [] : snapshot?.thread.messages ?? [];

  return (
    <div className="native-workspace">
      <aside className="native-sidebar">
        <div className="native-brand">
          <div><div className="eyebrow">T3 · Modal experiment</div><h1>Compadre</h1></div>
          <button className="new-thread" onClick={() => { setCreating(true); setSnapshot(null); setTitle("New thread"); setDraft(""); }}>＋</button>
        </div>
        <div className="thread-list">
          {threads.map((thread) => (
            <button key={threadKey(thread)} className={`thread-row ${threadKey(thread) === selectedKey && !creating ? "active" : ""}`} onClick={() => { setCreating(false); setSelectedKey(threadKey(thread)); }}>
              <span className="thread-row-title">{thread.title}</span>
              <span className="thread-row-meta"><i className={`status-dot ${thread.status === "working" ? "busy" : thread.status === "error" || thread.status === "unavailable" ? "error" : ""}`} />{thread.providerInstanceId === "codex" ? "Codex" : "Claude"} · {thread.status}</span>
            </button>
          ))}
          {threads.length === 0 && <p className="thread-list-empty">No threads yet.</p>}
        </div>
        <div className="native-sidebar-footer">
          <button className="quiet" onClick={onDisconnect}>Disconnect</button>
        </div>
      </aside>
      <main className="chat-panel">
        <header className="topbar native-topbar">
          <div><span className="field-label">{creating || !selected ? "New isolated thread" : selected.providerInstanceId === "codex" ? "Codex thread" : "Claude thread"}</span><strong>{creating || !selected ? title : selected.title}</strong></div>
          <div className="topbar-actions">
            {selected && !creating && <button className="secondary" disabled={busy} onClick={() => void loadSnapshot(selected)}>Refresh</button>}
            {selected && !creating && <button className="secondary" disabled={busy} onClick={openNative}>Open native T3 ↗</button>}
          </div>
        </header>
        <section className="transcript" ref={transcriptRef}>
          {messages.length === 0 ? (
            <div className="empty-state"><div className="spark">✦</div><h2>{creating || !selected ? "Start an isolated workspace" : "This thread is empty"}</h2><p>Each thread owns one Modal sandbox, one repository checkout, and one native T3 harness session.</p></div>
          ) : messages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              <div className="message-label">{message.role === "user" ? "You" : message.role === "assistant" ? "Agent" : "System"}</div>
              <div className="message-body"><div className="message-text">{message.text}{message.streaming && <span className="streaming-cursor"> ▍</span>}</div></div>
            </article>
          ))}
          {error && <div className="error-banner">{error}</div>}
        </section>
        <form className="composer native-composer" onSubmit={submit}>
          {(creating || !selected) && <input className="thread-title-input" aria-label="Thread title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Thread title" />}
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }} placeholder={creating || !selected ? "What should this agent work on?" : "Continue this thread…"} rows={3} />
          <div className="composer-footer native-composer-footer">
            <div className="model-controls">
              <select aria-label="Harness" value={provider} disabled={Boolean(selected && !creating)} onChange={(event) => chooseProvider(event.target.value as NativeProvider)}>
                <option value="codex">Codex</option>
                <option value="claudeAgent">Claude Code</option>
              </select>
              <select aria-label="Model" value={model} onChange={(event) => setModel(event.target.value)}>
                {!MODEL_OPTIONS[provider].includes(model) && <option value={model}>{model}</option>}
                {MODEL_OPTIONS[provider].map((name) => <option value={name} key={name}>{name}</option>)}
              </select>
            </div>
            {isWorking ? <button type="button" className="stop" disabled={busy} onClick={cancel}>Stop</button> : <button disabled={!draft.trim() || busy}>{busy ? "Starting…" : "Send"}</button>}
          </div>
        </form>
      </main>
    </div>
  );
}

function LegacyWorkspace({ apiKey, onDisconnect }: { apiKey: string; onDisconnect(): void }) {
  const [threadId, setThreadId] = useState(currentThread);
  const [threadDraft, setThreadDraft] = useState(threadId);

  useEffect(() => setCurrentThread(threadId), [threadId]);

  return <>
    <div className="thread-switcher">
      <form onSubmit={(event) => { event.preventDefault(); const next = threadDraft.trim(); if (next) setThreadId(next); }}>
        <input aria-label="Thread ID" value={threadDraft} onChange={(event) => setThreadDraft(event.target.value)} />
        <button className="secondary">Open thread</button>
      </form>
      <button className="quiet" onClick={onDisconnect}>Disconnect</button>
    </div>
    <ChatWorkspace key={`${threadId}:${apiKey}`} apiKey={apiKey} threadId={threadId} />
  </>;
}

function App() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(API_KEY_STORAGE) || "");
  const [apiKeyDraft, setApiKeyDraft] = useState(apiKey);
  const [surface, setSurface] = useState<"loading" | "native" | "legacy" | "error">("loading");
  const [surfaceError, setSurfaceError] = useState("");

  useEffect(() => {
    if (!apiKey) return;
    let active = true;
    fetch("/hosted/t3/threads", { headers: { Authorization: `Bearer ${apiKey}` } })
      .then(async (response) => {
        if (!active) return;
        if (response.ok) setSurface("native");
        else if (response.status === 404) setSurface("legacy");
        else {
          const payload = await response.json().catch(() => null) as { error?: string } | null;
          setSurfaceError(payload?.error || `Could not connect (${response.status})`);
          setSurface("error");
        }
      })
      .catch((cause) => {
        if (!active) return;
        setSurfaceError(cause instanceof Error ? cause.message : "Could not connect");
        setSurface("error");
      });
    return () => { active = false; };
  }, [apiKey]);

  function disconnect() {
    localStorage.removeItem(API_KEY_STORAGE);
    setApiKey("");
    setSurface("loading");
  }

  if (!apiKey) {
    return <main className="gate"><form onSubmit={(event) => { event.preventDefault(); const key = apiKeyDraft.trim(); if (!key) return; localStorage.setItem(API_KEY_STORAGE, key); setSurface("loading"); setApiKey(key); }}><div className="brand-mark">C</div><div className="eyebrow">Compadre hosted experiment</div><h1>Connect to your workspace</h1><p>The experiment uses the same API key as the Compadre service.</p><label>API key<input type="password" autoFocus value={apiKeyDraft} onChange={(event) => setApiKeyDraft(event.target.value)} placeholder="Paste COMPADRE_API_KEY" /></label><button>Continue</button></form></main>;
  }
  if (surface === "loading") return <main className="gate"><div className="loading-card"><div className="spark">✦</div><p>Loading thread directory…</p></div></main>;
  if (surface === "error") return <main className="gate"><div className="loading-card"><div className="error-banner">{surfaceError}</div><button className="secondary" onClick={disconnect}>Try another key</button></div></main>;
  return surface === "native"
    ? <NativeT3Workspace apiKey={apiKey} onDisconnect={disconnect} />
    : <LegacyWorkspace apiKey={apiKey} onDisconnect={disconnect} />;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
