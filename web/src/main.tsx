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

function App() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(API_KEY_STORAGE) || "");
  const [apiKeyDraft, setApiKeyDraft] = useState(apiKey);
  const [threadId, setThreadId] = useState(currentThread);
  const [threadDraft, setThreadDraft] = useState(threadId);

  useEffect(() => setCurrentThread(threadId), [threadId]);

  if (!apiKey) {
    return <main className="gate"><form onSubmit={(event) => { event.preventDefault(); const key = apiKeyDraft.trim(); if (!key) return; localStorage.setItem(API_KEY_STORAGE, key); setApiKey(key); }}><div className="brand-mark">C</div><div className="eyebrow">Compadre hosted experiment</div><h1>Connect to your workspace</h1><p>The experiment uses the same API key as the Compadre service.</p><label>API key<input type="password" autoFocus value={apiKeyDraft} onChange={(event) => setApiKeyDraft(event.target.value)} placeholder="Paste COMPADRE_API_KEY" /></label><button>Continue</button></form></main>;
  }

  return <>
    <div className="thread-switcher">
      <form onSubmit={(event) => { event.preventDefault(); const next = threadDraft.trim(); if (next) setThreadId(next); }}>
        <input aria-label="Thread ID" value={threadDraft} onChange={(event) => setThreadDraft(event.target.value)} />
        <button className="secondary">Open thread</button>
      </form>
      <button className="quiet" onClick={() => { localStorage.removeItem(API_KEY_STORAGE); setApiKey(""); }}>Disconnect</button>
    </div>
    <ChatWorkspace key={`${threadId}:${apiKey}`} apiKey={apiKey} threadId={threadId} />
  </>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
