import { useEffect, useRef, useState } from "react";
import type { RpcClient, ChatSessionSummary, ChatMessage, ChatToolCall, WhoamiResult, ModelsListResult } from "@zero/protocol";
import type { ChatStore } from "./store";
import type { TurnStore } from "./turnStore";
import { CODE_FONT, ToolAvatar, renderFormattedMessage } from "./messageFormatting";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "just now" / "5m ago" / "3h ago" / "2d ago" / calendar date beyond that,
 * for the message-row label. The full timestamp always stays available via
 * the caller's `title` (native hover tooltip). */
function humanizeTimestamp(ts: number, now = Date.now()): string {
  const delta = now - ts;
  if (delta < MINUTE_MS) return "just now";
  if (delta < HOUR_MS) return `${Math.floor(delta / MINUTE_MS)}m ago`;
  if (delta < DAY_MS) return `${Math.floor(delta / HOUR_MS)}h ago`;
  if (delta < 7 * DAY_MS) return `${Math.floor(delta / DAY_MS)}d ago`;
  return new Date(ts).toLocaleDateString();
}

/** Display name for a message's `role`: the local OS username for "user"
 * (fetched once via system/whoami), "Zero" for the assistant, and
 * "tool:<name>" unchanged for tool results. */
function roleLabel(role: ChatMessage["role"], toolName: string | undefined, username: string): string {
  if (role === "user") return username;
  if (role === "tool") return `tool:${toolName}`;
  return "Zero";
}

/** Whether to show the "Zero is thinking…" indicator. Pulled out as a pure
 * function (rather than an inline JSX condition) so its logic - show as soon
 * as a turn is in flight and nothing has rendered for it yet, not only once
 * the first streamed event (e.g. a tool call) arrives - is directly
 * testable without needing to drive ChatPanel's full DOM/RPC stack. */
export function shouldShowThinkingIndicator(state: {
  busy: boolean; streaming: string; pendingApproval: unknown;
}): boolean {
  return state.busy && !state.streaming && !state.pendingApproval;
}

/** One tool-result row's content: an unstyled `<pre>` block, the same
 * treatment tool output has always had (it's already structured/verbatim
 * data, not prose to format-detect). Factored out so both the flat message
 * list and `ToolGroup`'s expanded rows render it identically. */
function ToolMessageRow(props: { message: ChatMessage; username: string }) {
  const { message: m, username } = props;
  return (
    <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 8 }}>
      <div style={{
        maxWidth: "80%", padding: "6px 10px", borderRadius: 12,
        background: "var(--zero-editor-bg)", color: "var(--zero-editor-fg)",
        border: "1px solid var(--zero-border)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
          <ToolAvatar />
          <strong>{roleLabel(m.role, m.toolName, username)}</strong>
          <span
            style={{ marginLeft: "auto", fontSize: 11, opacity: 0.7 }}
            title={m.createdAt ? new Date(m.createdAt).toLocaleString() : undefined}
          >
            {m.createdAt ? humanizeTimestamp(m.createdAt) : null}
          </span>
        </div>
        <pre style={{
          margin: 0, padding: 8, borderRadius: 4, overflowX: "auto", maxHeight: 320,
          background: "var(--zero-sidebar-bg)", border: "1px solid var(--zero-border)",
          color: "var(--zero-editor-fg)", fontFamily: CODE_FONT, fontSize: 12,
        }}>
          {m.content}
        </pre>
      </div>
    </div>
  );
}

/** A run of consecutive tool-result messages within a turn, collapsed by
 * default (even a single call) into one muted summary line - a wall of raw
 * tool output previously pushed the actual conversation out of view. */
function ToolGroup(props: { messages: ChatMessage[]; username: string }) {
  const [open, setOpen] = useState(false);
  const { messages, username } = props;
  return (
    <div style={{ marginBottom: 8 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex", alignItems: "center", gap: 6, opacity: 0.55, fontSize: 12,
          background: "transparent", border: "none", color: "inherit", cursor: "pointer", padding: "2px 4px",
        }}
      >
        <span>{open ? "▾" : "▸"}</span>
        <ToolAvatar />
        <span>{messages.length} tool call{messages.length === 1 ? "" : "s"}</span>
      </button>
      {open && messages.map((m, i) => <ToolMessageRow key={i} message={m} username={username} />)}
    </div>
  );
}

/** Groups a flat message list into renderable items, collapsing runs of
 * consecutive tool-result messages (see `ToolGroup`) - everything else
 * renders one-for-one as before. */
export function groupForDisplay<M extends ChatMessage>(messages: M[]): ({ kind: "message"; message: M } | { kind: "toolGroup"; messages: M[] })[] {
  const items: ({ kind: "message"; message: M } | { kind: "toolGroup"; messages: M[] })[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i]!;
    if (m.role === "tool") {
      const group: M[] = [];
      while (i < messages.length && messages[i]!.role === "tool") {
        group.push(messages[i]!);
        i++;
      }
      items.push({ kind: "toolGroup", messages: group });
    } else {
      items.push({ kind: "message", message: m });
      i++;
    }
  }
  return items;
}

export function ChatPanel(props: { client: RpcClient; turnStore: TurnStore; chatStore: ChatStore }) {
  const { client, turnStore, chatStore } = props;
  const [username, setUsername] = useState("you");
  useEffect(() => {
    client.request<WhoamiResult>("system/whoami", {})
      .then((r) => setUsername(r.username))
      .catch(() => {});
  }, [client]);
  const [, setVersion] = useState(0);
  useEffect(() => chatStore.subscribe(() => setVersion((v) => v + 1)), [chatStore]);

  // `tokensUsed` is a client-only annotation (from the turn's "done" event,
  // never persisted/round-tripped) shown under an assistant reply so a user
  // can see roughly how much of the context budget that turn cost.
  const [messages, setMessages] = useState<(ChatMessage & { tokensUsed?: number })[]>([]);
  const [streaming, setStreaming] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<{ turnId: string; call: ChatToolCall; preview: string } | null>(null);
  const [status, setStatus] = useState<{ activeModel: string | null; reason: string | null }>({ activeModel: null, reason: null });
  const [catalog, setCatalog] = useState<ModelsListResult>({ url: "", models: [], running: [], active: null });
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
  const inputRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    let cancelled = false;
    client.request<ModelsListResult>("models/list")
      .then((r) => {
        if (cancelled) return;
        setCatalog(r);
        if (r.active) {
          localStorage.setItem("zero.ollamaModel", r.active);
          localStorage.removeItem("zero.ollamaChatModel");
        }
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [client]);

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

  // Auto-scroll to bottom when pinned and new messages/streaming text/an
  // approval prompt arrive - the approval prompt now renders inline in this
  // same scroll area (not a separate fixed section), so it needs the same
  // "pull it into view" treatment as a new message.
  useEffect(() => {
    if (pinnedToBottom) listRef.current?.scrollTo({ top: listRef.current?.scrollHeight ?? 0 });
  }, [messages.length, streaming.length, pinnedToBottom, pendingApproval]);

  // Return focus to the textbox once a send/response cycle finishes (busy
  // true -> false), matching where the user was typing - otherwise it's lost
  // to whatever the browser focused last (often nothing), forcing a click
  // back into the box before the next message.
  const prevBusyRef = useRef(busy);
  useEffect(() => {
    if (prevBusyRef.current && !busy) inputRef.current?.focus();
    prevBusyRef.current = busy;
  }, [busy]);

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
            setMessages((m) => [...m, { ...event.message, tokensUsed: event.tokensUsed }]);
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
        {sessions.length > 0 && (
          <>
            <span style={{ opacity: 0.7, fontSize: 13 }}>Sessions</span>
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
          </>
        )}
        <button onClick={() => void newSession()} title="Start a new chat session">+ New session</button>
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
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: (catalog.active ?? status.activeModel) !== null ? "var(--zero-status-ok)" : "var(--zero-status-idle)", flexShrink: 0 }} />
            <span style={{ opacity: 0.7, marginRight: 4 }}>Chat:</span>
            {catalog.models.length > 0 ? (
              <select
                aria-label="Ollama model"
                value={catalog.active ?? catalog.models[0]}
                onChange={(e) => {
                  const model = e.target.value;
                  setCatalog((c) => ({ ...c, active: model }));
                  localStorage.setItem("zero.ollamaModel", model);
                  void client.request<ModelsListResult>("models/set", { model })
                    .then(setCatalog)
                    .catch((err) => reportError(`failed to set model: ${err instanceof Error ? err.message : String(err)}`));
                }}
                style={{
                  background: "transparent",
                  color: "inherit",
                  border: "none",
                  fontSize: 14,
                  maxWidth: 220,
                }}
              >
                {catalog.models.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            ) : (
              <span>{status.activeModel ?? "no chat model"}</span>
            )}
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
              {groupForDisplay(messages.filter((m) => m.role !== "system")).map((item, i) => {
                if (item.kind === "toolGroup") return <ToolGroup key={i} messages={item.messages} username={username} />;
                const m = item.message;
                const isUser = m.role === "user";
                return (
                  <div key={i} style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", marginBottom: 8 }}>
                    <div style={{
                      maxWidth: "80%", padding: "6px 10px", borderRadius: 12,
                      background: isUser ? "var(--zero-accent)" : "var(--zero-editor-bg)",
                      color: isUser ? "var(--zero-accent-fg)" : "var(--zero-editor-fg)",
                      border: isUser ? "none" : "1px solid var(--zero-border)",
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                        <strong>{roleLabel(m.role, m.toolName, username)}</strong>
                        <span
                          style={{ marginLeft: "auto", fontSize: 11, opacity: 0.7 }}
                          title={m.createdAt ? new Date(m.createdAt).toLocaleString() : undefined}
                        >
                          {m.createdAt ? humanizeTimestamp(m.createdAt) : null}
                        </span>
                      </div>
                      <div>{renderFormattedMessage(m.content)}</div>
                      {m.tokensUsed != null && (
                        <div style={{ fontSize: 11, opacity: 0.55, marginTop: 4 }}>
                          ~{m.tokensUsed.toLocaleString()} tokens this turn
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {streaming && (
                <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 8 }}>
                  <div style={{
                    maxWidth: "80%", padding: "6px 10px", borderRadius: 12,
                    background: "var(--zero-editor-bg)", color: "var(--zero-editor-fg)",
                    border: "1px solid var(--zero-border)",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                      <strong>Zero</strong>
                      <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.7 }}>
                        {humanizeTimestamp(Date.now())}
                      </span>
                    </div>
                    <div>{renderFormattedMessage(streaming)}</div>
                  </div>
                </div>
              )}
              {pendingApproval && (
                <div style={{
                  marginBottom: 8, padding: "6px 10px", borderRadius: 6,
                  background: "var(--zero-editor-bg)", border: "1px solid var(--zero-accent)",
                }}>
                  <div style={{ fontSize: 13, marginBottom: 4 }}>Approve {pendingApproval.call.name}?</div>
                  <pre style={{ maxHeight: 200, overflow: "auto", fontSize: 12, whiteSpace: "pre-wrap", background: "var(--zero-sidebar-bg)", border: "1px solid var(--zero-border)", borderRadius: 4, padding: 6 }}>{pendingApproval.preview}</pre>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      onClick={() => void approve(true)}
                      style={{ background: "var(--zero-accent)", color: "var(--zero-accent-fg)", border: "none" }}
                    >
                      Approve
                    </button>
                    <button onClick={() => void approve(false)}>Deny</button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        {!pinnedToBottom && (
          <button
            aria-label="Scroll to new messages"
            onClick={() => { listRef.current?.scrollTo({ top: listRef.current?.scrollHeight ?? 0, behavior: "smooth" }); setPinnedToBottom(true); }}
            style={{
              position: "absolute", bottom: 12, left: "50%", transform: "translateX(-50%)",
              borderRadius: 16, padding: "6px 12px",
              background: "var(--zero-accent)", color: "var(--zero-accent-fg)", border: "none", cursor: "pointer",
            }}
          >
            ↓ New messages
          </button>
        )}
      </div>
      {shouldShowThinkingIndicator({ busy, streaming, pendingApproval }) && (
        <div role="status" style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--zero-statusbar-fg)", opacity: 0.8, padding: "4px 10px", borderTop: "1px solid var(--zero-border)", background: "var(--zero-editor-bg)" }}>
          <span className="zero-typing-dot" />
          <span className="zero-typing-dot" />
          <span className="zero-typing-dot" />
          <span>Zero is thinking…</span>
        </div>
      )}
      <div style={{ display: "flex", gap: 4, padding: 8, borderTop: "1px solid var(--zero-border)" }}>
        <input
          ref={inputRef}
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
          style={!busy && activeId && input.trim() ? { background: "var(--zero-accent)", color: "var(--zero-accent-fg)", border: "none" } : undefined}
        >
          {busy ? "Stop" : "Send"}
        </button>
      </div>
    </div>
  );
}
