import { useEffect, useRef, useState } from "react";
import type { RpcClient, ChatSessionSummary, ChatMessage, ChatToolCall } from "@zero/protocol";
import type { ChatStore } from "./store";
import type { TurnStore } from "./turnStore";

export function ChatPanel(props: { client: RpcClient; turnStore: TurnStore; chatStore: ChatStore }) {
  const { client, turnStore, chatStore } = props;
  const [, setVersion] = useState(0);
  useEffect(() => chatStore.subscribe(() => setVersion((v) => v + 1)), [chatStore]);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<{ turnId: string; call: ChatToolCall; preview: string } | null>(null);
  const [status, setStatus] = useState<{ activeModel: string | null; reason: string | null }>({ activeModel: null, reason: null });
  const [turnId, setTurnId] = useState<string | null>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  // Settles the in-flight `send()` promise (unsubscribes from TurnStore,
  // resolves) for the current turn, if any. `chat/abort` only signals the
  // daemon's AbortController - AgentRuntime.sendMessage returns silently on
  // an aborted signal without yielding a closing "done"/"error" event, so
  // nothing would otherwise unblock `send()`'s awaited Promise or unsubscribe
  // its TurnStore listener. Every abort path (Stop button, session switch,
  // close, unmount) must call this alongside `chat/abort` to avoid a leaked
  // listener and a `busy` state stuck true forever.
  const finishTurnRef = useRef<(() => void) | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  function abortCurrentTurn(): void {
    if (turnId) client.request("chat/abort", { turnId }).catch(() => {});
    finishTurnRef.current?.();
    setPendingApproval(null);
    setTurnId(null);
  }

  const sessions = chatStore.getSessions();
  const activeId = chatStore.getActiveId();

  function reportError(message: string): void {
    setBanner(message);
  }

  function handleScroll(): void {
    const el = listRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinnedToBottom(distanceFromBottom < 40);
  }

  function refreshStatus(sessionId: string): void {
    client.request<{ activeModel: string | null; reason: string | null }>("chat/status", { sessionId })
      .then(setStatus)
      .catch(() => {});
  }

  useEffect(() => {
    client.request<{ sessions: ChatSessionSummary[] }>("chat/list")
      .then((r) => chatStore.setSessions(r.sessions))
      .catch((e) => reportError(`failed to load chats: ${e instanceof Error ? e.message : String(e)}`));
  }, [client, chatStore]);

  // Fix #1 & #2: Abort the previous session's in-flight turn (if any) and
  // clear streaming/approval state when switching sessions - otherwise a
  // late event from the old turn could land on the newly active session's
  // transcript.
  useEffect(() => {
    abortCurrentTurn();
    setStreaming("");
    setPendingApproval(null);
    // abortCurrentTurn reads client/turnIdRef/finishTurnRef via refs/props
    // that don't need to be dependencies; only activeId should retrigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // Fix #3: Guard against stale responses for out-of-order chat/get calls.
  useEffect(() => {
    if (!activeId) { setMessages([]); return; }
    const id = activeId;
    let cancelled = false;
    client.request<{ messages: ChatMessage[] }>("chat/get", { id }).then((r) => {
      if (!cancelled) {
        setMessages(r.messages);
      }
    }).catch((e) => {
      if (!cancelled) reportError(`failed to load chat: ${e instanceof Error ? e.message : String(e)}`);
    });
    refreshStatus(id);
    return () => { cancelled = true; };
  }, [client, activeId]);

  // Auto-scroll to bottom when pinned and new messages/streaming text arrive
  useEffect(() => {
    if (pinnedToBottom) listRef.current?.scrollTo({ top: listRef.current?.scrollHeight ?? 0 });
  }, [messages.length, streaming.length, pinnedToBottom]);

  // Fix #4: Cleanup on unmount - abort any in-flight turn, reading the
  // current turnId from the ref (via abortCurrentTurn) so this always targets
  // the live turn rather than whatever turn existed when the effect was
  // registered.
  useEffect(() => {
    return () => {
      abortCurrentTurn();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  async function newSession(): Promise<void> {
    try {
      const { id } = await client.request<{ id: string }>("chat/create", {});
      chatStore.addSession({ id, title: "New chat", updatedAt: Date.now(), messageCount: 0 });
    } catch (e) {
      reportError(`failed to create chat: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function closeSession(id: string): void {
    // Fix #2b: If closing the active session, abort any in-flight turn.
    if (id === activeId) abortCurrentTurn();
    void client.request("chat/delete", { id });
    chatStore.removeSession(id);
  }

  async function approve(approved: boolean): Promise<void> {
    if (!pendingApproval) return;
    await client.request("chat/approve", { turnId: pendingApproval.turnId, callId: pendingApproval.call.id, approved }).catch(() => {});
    setPendingApproval(null);
  }

  async function send(): Promise<void> {
    if (!activeId || !input.trim() || busy) return;
    const sessionId = activeId;
    const text = input;
    const isFirstExchange = messages.length === 0;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: text, createdAt: Date.now() }]);
    setStreaming("");
    setBusy(true);

    try {
      const { turnId } = await client.request<{ turnId: string }>("chat/turn", { sessionId, userText: text });
      setTurnId(turnId);
      await new Promise<void>((resolve) => {
        // `finish` is declared before use but assigned after `onEvent`
        // registers the listener below - safe because `onEvent` only stores
        // the listener synchronously and never invokes it inline, so `finish`
        // is always assigned by the time any event can actually fire. Every
        // exit path (error, done, or an external abort via
        // `abortCurrentTurn`) funnels through this single `finish` so the
        // listener is unsubscribed and the promise resolved exactly once -
        // calling it twice is harmless (Set#delete/Promise#resolve are both
        // idempotent no-ops on a second call).
        let finish: () => void = () => {};
        const unsub = turnStore.onEvent(turnId, (event) => {
          if (event.type === "text") {
            setStreaming((s) => s + event.delta);
          } else if (event.type === "approvalRequest") {
            setPendingApproval({ turnId, call: event.call, preview: event.preview });
          } else if (event.type === "toolResult") {
            setPendingApproval(null);
            setMessages((m) => [...m, { role: "tool", content: event.result, toolName: event.call.name, createdAt: Date.now() }]);
          } else if (event.type === "error") {
            setMessages((m) => [...m, { role: "tool", content: event.message, toolName: "error", createdAt: Date.now() }]);
            finish();
          } else if (event.type === "done") {
            setMessages((m) => [...m, event.message]);
            setStreaming("");
            const current = chatStore.getSessions().find((s) => s.id === sessionId);
            if (isFirstExchange && current?.title === "New chat") {
              const title = text.trim().slice(0, 40) + (text.trim().length > 40 ? "…" : "");
              chatStore.touchSession(sessionId, title);
              client.request("chat/rename", { id: sessionId, title }).catch(() => {
                // Non-fatal: local title already updated, persistence can be retried later.
              });
            }
            finish();
          }
        });
        finish = () => {
          unsub();
          finishTurnRef.current = null;
          resolve();
        };
        finishTurnRef.current = finish;
      });
    } catch (e) {
      reportError(`failed to send: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTurnId(null);
      setBusy(false);
      chatStore.touchSession(sessionId);
      // Guard against a status response for a session the user has since
      // navigated away from clobbering the currently displayed pill.
      if (chatStore.getActiveId() === sessionId) refreshStatus(sessionId);
    }
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--zero-editor-bg)", color: "var(--zero-editor-fg)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderBottom: "1px solid var(--zero-border)" }}>
        <select
          aria-label="Chat session"
          value={activeId ?? ""}
          onChange={(e) => chatStore.setActive(e.target.value)}
          style={{
            background: "var(--zero-sidebar-bg)",
            color: "var(--zero-sidebar-fg)",
            border: "1px solid var(--zero-border)",
            borderRadius: 4,
            padding: "4px 8px",
          }}
        >
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>{s.title ?? s.id}</option>
          ))}
        </select>
        <button onClick={() => void newSession()} title="New chat session">+</button>
        {sessions.length > 1 && (
          <button onClick={() => activeId && closeSession(activeId)} title="Delete current chat session">Delete</button>
        )}
        <div style={{ marginLeft: "auto", padding: "4px 8px" }}>
          <div
            title={status.reason ?? undefined}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6, padding: "2px 8px", borderRadius: 12,
              border: "1px solid var(--zero-border)", fontSize: 14, color: "var(--zero-statusbar-fg)",
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: status.activeModel !== null ? "var(--zero-status-ok)" : "var(--zero-status-idle)", flexShrink: 0 }} />
            {status.activeModel ?? "no chat model"}
          </div>
        </div>
      </div>
      {banner && (
        <div
          style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "4px 8px", background: "var(--zero-error-bg)", color: "var(--zero-error-fg)", fontSize: 13,
          }}
        >
          <span>⚠ {banner}</span>
          <button onClick={() => setBanner(null)} aria-label="Dismiss error">×</button>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <div ref={listRef} onScroll={handleScroll} style={{ height: "100%", overflowY: "auto", padding: 8 }}>
          {!activeId ? (
            <div style={{ padding: 16, opacity: 0.6 }}>No chat open</div>
          ) : (
            <>
              {messages.filter((m) => m.role !== "system").map((m, i) => (
                <div key={i} style={{
                  marginBottom: 8, padding: "6px 10px", borderRadius: 6,
                  background: m.role === "user" ? "var(--zero-selection-bg)" : "var(--zero-editor-bg)",
                  border: "1px solid var(--zero-border)",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                    <span aria-hidden style={{
                      width: 18, height: 18, borderRadius: "50%", display: "inline-flex",
                      alignItems: "center", justifyContent: "center", fontSize: 11,
                      background: m.role === "user" ? "var(--zero-accent)" : "var(--zero-status-ok)",
                      color: "#fff",
                    }}>
                      {m.role === "user" ? "U" : m.role === "tool" ? "T" : "Z"}
                    </span>
                    <strong>{m.role === "tool" ? `tool:${m.toolName}` : m.role}</strong>
                    <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.6 }}>
                      {m.createdAt ? new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null}
                    </span>
                  </div>
                  <div style={{ whiteSpace: "pre-wrap", color: "var(--zero-editor-fg)" }}>{m.content}</div>
                </div>
              ))}
              {streaming && (
                <div style={{
                  marginBottom: 8, padding: "6px 10px", borderRadius: 6,
                  background: "var(--zero-editor-bg)",
                  border: "1px solid var(--zero-border)",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                    <span aria-hidden style={{
                      width: 18, height: 18, borderRadius: "50%", display: "inline-flex",
                      alignItems: "center", justifyContent: "center", fontSize: 11,
                      background: "var(--zero-status-ok)",
                      color: "#fff",
                    }}>
                      Z
                    </span>
                    <strong>assistant</strong>
                    <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.6 }}>
                      {new Date(Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                  <div style={{ whiteSpace: "pre-wrap", color: "var(--zero-editor-fg)" }}>{streaming}</div>
                </div>
              )}
            </>
          )}
        </div>
        {!pinnedToBottom && (
          <button
            onClick={() => { listRef.current?.scrollTo({ top: listRef.current?.scrollHeight ?? 0, behavior: "smooth" }); setPinnedToBottom(true); }}
            style={{
              position: "absolute", bottom: 60, right: 20, borderRadius: 16, padding: "6px 12px",
              background: "var(--zero-accent)", color: "#fff", border: "none", cursor: "pointer",
            }}
          >
            ↓ New messages
          </button>
        )}
      </div>
      {pendingApproval && (
        <div style={{ padding: 8, borderTop: "1px solid var(--zero-border)", background: "var(--zero-editor-bg)" }}>
          <div style={{ fontSize: 13, marginBottom: 4 }}>Approve {pendingApproval.call.name}?</div>
          <pre style={{ maxHeight: 160, overflow: "auto", fontSize: 12, whiteSpace: "pre-wrap" }}>{pendingApproval.preview}</pre>
          <button onClick={() => void approve(true)}>Approve</button>
          <button onClick={() => void approve(false)}>Deny</button>
        </div>
      )}
      {turnId && turnStore.isActive(turnId) && (
        <div role="status" style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--zero-statusbar-fg)", opacity: 0.8, padding: "4px 10px", borderTop: "1px solid var(--zero-border)", background: "var(--zero-editor-bg)" }}>
          <span className="zero-typing-dot" />
          <span className="zero-typing-dot" />
          <span className="zero-typing-dot" />
          <span>Zero is thinking…</span>
        </div>
      )}
      <div style={{ display: "flex", gap: 4, padding: 8, borderTop: "1px solid var(--zero-border)" }}>
        <input
          style={{ flex: 1 }}
          value={input}
          disabled={!activeId || busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder={activeId ? "Ask Zero..." : "Open a chat to start"}
        />
        <button
          onClick={() => (busy ? abortCurrentTurn() : void send())}
          disabled={!activeId || (!busy && !input.trim())}
        >
          {busy ? "Stop" : "Send"}
        </button>
      </div>
    </div>
  );
}
