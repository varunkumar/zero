import { useEffect, useRef, useState } from "react";
import type { RpcClient, ChatSessionSummary, ChatMessage, ChatToolCall, WhoamiResult } from "@zero/protocol";
import type { ChatStore } from "./store";
import type { TurnStore } from "./turnStore";
import { highlightCode, highlightDiff } from "./codeHighlight";

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

const CODE_FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** Renders inline `` `code` `` spans within a plain-text segment (already
 * known to contain no fenced code blocks - those are split out by
 * `renderMessageContent` before this runs). */
function renderInlineCode(text: string, keyPrefix: string): React.ReactNode[] {
  const segments = text.split(/`([^`\n]+)`/g);
  return segments.map((seg, i) =>
    i % 2 === 1 ? (
      <code key={`${keyPrefix}-${i}`} style={{
        background: "var(--zero-sidebar-bg)", border: "1px solid var(--zero-border)",
        color: "var(--zero-editor-fg)", borderRadius: 3, padding: "1px 4px", fontFamily: CODE_FONT, fontSize: "0.9em",
      }}>
        {seg}
      </code>
    ) : (
      seg
    ),
  );
}

/** A fenced code block, syntax-highlighted when `lang` is recognized
 * (`highlightCode` returns null for anything it doesn't have a grammar
 * for), diff-colored for "diff"/"patch", or left as plain monospace text
 * otherwise - always themed and horizontally scrollable either way. */
function CodeBlock(props: { lang: string; code: string }) {
  const body = props.code.replace(/\n$/, ""); // trailing newline before the closing ``` renders as a blank last line otherwise
  const isDiff = props.lang === "diff" || props.lang === "patch";
  const highlighted = isDiff ? null : highlightCode(body, props.lang);
  return (
    <pre style={{
      margin: "6px 0", padding: 8, borderRadius: 4, overflowX: "auto",
      background: "var(--zero-sidebar-bg)", border: "1px solid var(--zero-border)",
      color: "var(--zero-editor-fg)", fontFamily: CODE_FONT, fontSize: 12,
    }}>
      {isDiff ? <code>{highlightDiff(body)}</code> : <code>{highlighted ?? body}</code>}
    </pre>
  );
}

/** Renders a chat message body with fenced ```lang code blocks (syntax- or
 * diff-highlighted, see `CodeBlock`) and inline `code` spans styled as code
 * rather than as flat pre-wrap text - tool output and code snippets were
 * previously indistinguishable from prose. */
function renderMessageContent(text: string): React.ReactNode {
  const parts = text.split(/```(\w*)\n([\s\S]*?)```/g);
  // With two capture groups, split() interleaves [text, lang, code, text,
  // lang, code, ..., text]: index%3===0 is surrounding prose, %3===1 is the
  // fence's language tag, %3===2 is the code body (consumed alongside its
  // language tag, so it's skipped when encountered on its own below).
  return parts.map((part, i) => {
    const mod = i % 3;
    if (mod === 2) return null;
    if (mod === 1) return <CodeBlock key={i} lang={part} code={parts[i + 1] ?? ""} />;
    if (!part) return null;
    return <span key={i} style={{ whiteSpace: "pre-wrap" }}>{renderInlineCode(part, String(i))}</span>;
  });
}

/** Small "T" badge preceding a tool-result row. User and assistant rows
 * carry no icon at all - role is already conveyed by which side of the
 * panel the bubble sits on (see the message-row alignment below) and by
 * the role label itself. */
function ToolAvatar() {
  return (
    <span aria-hidden style={{
      width: 18, height: 18, borderRadius: "50%", display: "inline-flex",
      alignItems: "center", justifyContent: "center", fontSize: 11, flexShrink: 0,
      background: "var(--zero-status-ok)", color: "#fff",
    }}>
      T
    </span>
  );
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
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: status.activeModel !== null ? "var(--zero-status-ok)" : "var(--zero-status-idle)", flexShrink: 0 }} />
            <span style={{ opacity: 0.7, marginRight: 4 }}>Chat:</span>
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
              {messages.filter((m) => m.role !== "system").map((m, i) => {
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
                        {m.role === "tool" && <ToolAvatar />}
                        <strong>{roleLabel(m.role, m.toolName, username)}</strong>
                        <span
                          style={{ marginLeft: "auto", fontSize: 11, opacity: 0.7 }}
                          title={m.createdAt ? new Date(m.createdAt).toLocaleString() : undefined}
                        >
                          {m.createdAt ? humanizeTimestamp(m.createdAt) : null}
                        </span>
                      </div>
                      <div>
                        {m.role === "tool" ? (
                          <pre style={{
                            margin: 0, padding: 8, borderRadius: 4, overflowX: "auto", maxHeight: 320,
                            background: "var(--zero-sidebar-bg)", border: "1px solid var(--zero-border)",
                            color: "var(--zero-editor-fg)", fontFamily: CODE_FONT, fontSize: 12,
                          }}>
                            {m.content}
                          </pre>
                        ) : (
                          renderMessageContent(m.content)
                        )}
                      </div>
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
                    <div>{renderMessageContent(streaming)}</div>
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
