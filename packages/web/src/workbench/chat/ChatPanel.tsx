import { useEffect, useRef, useState } from "react";
import type { RpcClient, ChatSessionSummary } from "@zero/protocol";
import type { AgentRuntime, AgentRuntimeStatus, ChatMessage } from "@zero/core";
import type { ChatStore } from "./store";

function ChatStatusPill(props: { runtime: AgentRuntime }) {
  const [status, setStatus] = useState<AgentRuntimeStatus>(() => props.runtime.status());
  useEffect(() => {
    setStatus(props.runtime.status());
    props.runtime.onStatusChange(setStatus);
  }, [props.runtime]);
  const active = status.activeModel !== null;
  return (
    <div
      title={status.reason ?? undefined}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6, padding: "2px 8px", borderRadius: 12,
        border: "1px solid var(--zero-border)", fontSize: 14, color: "var(--zero-statusbar-fg)",
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: active ? "#2ecc71" : "#999", flexShrink: 0 }} />
      {status.activeModel ?? "no chat model"}
    </div>
  );
}

export function ChatPanel(props: { client: RpcClient; runtime: AgentRuntime; chatStore: ChatStore }) {
  const { client, runtime, chatStore } = props;
  const [, setVersion] = useState(0);
  useEffect(() => chatStore.subscribe(() => setVersion((v) => v + 1)), [chatStore]);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const sessions = chatStore.getSessions();
  const activeId = chatStore.getActiveId();

  useEffect(() => {
    client.request<{ sessions: ChatSessionSummary[] }>("chat/list").then((r) => chatStore.setSessions(r.sessions));
  }, [client, chatStore]);

  // Fix #1 & #2: Clean up previous session's in-flight turn and streaming text when switching sessions
  useEffect(() => {
    abortRef.current?.abort();
    setStreaming("");
  }, [activeId]);

  // Fix #3: Guard against stale responses for out-of-order chat/get calls
  useEffect(() => {
    if (!activeId) { setMessages([]); return; }
    const id = activeId;
    let cancelled = false;
    client.request<{ messages: ChatMessage[] }>("chat/get", { id }).then((r) => {
      if (!cancelled) {
        setMessages(r.messages);
      }
    });
    return () => { cancelled = true; };
  }, [client, activeId]);

  // Fix #4: Cleanup on unmount - stop any in-flight turn
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  async function newSession(): Promise<void> {
    const { id } = await client.request<{ id: string }>("chat/create", {});
    chatStore.addSession({ id, title: "New chat", updatedAt: Date.now(), messageCount: 0 });
  }

  function closeSession(id: string): void {
    // Fix #2b: If closing the active session, abort any in-flight turn
    if (id === activeId) {
      abortRef.current?.abort();
    }
    void client.request("chat/delete", { id });
    chatStore.removeSession(id);
  }

  async function send(): Promise<void> {
    if (!activeId || !input.trim() || busy) return;
    const text = input;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: text, createdAt: Date.now() }]);
    setStreaming("");
    setBusy(true);
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      for await (const event of runtime.sendMessage(activeId, text, ctl.signal)) {
        if (event.type === "text") {
          setStreaming((s) => s + event.delta);
        } else if (event.type === "toolResult") {
          setMessages((m) => [...m, { role: "tool", content: event.result, toolName: event.call.name, createdAt: Date.now() }]);
        } else if (event.type === "done") {
          setMessages((m) => [...m, event.message]);
          setStreaming("");
        }
      }
    } finally {
      setBusy(false);
      chatStore.touchSession(activeId);
    }
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--zero-editor-bg)", color: "var(--zero-editor-fg)" }}>
      <div className="zero-tabstrip" role="tablist">
        {sessions.map((s) => (
          <div key={s.id} className="zero-tab" role="tab" aria-selected={s.id === activeId} onClick={() => chatStore.setActive(s.id)}>
            <span>{s.title}</span>
            <button className="zero-tab-close" aria-label={`Close chat ${s.title}`}
              onClick={(e) => { e.stopPropagation(); closeSession(s.id); }}>
              ×
            </button>
          </div>
        ))}
        <button aria-label="New chat" onClick={() => void newSession()} style={{ marginLeft: 4 }}>+</button>
        <div style={{ marginLeft: "auto", padding: "4px 8px" }}>
          <ChatStatusPill runtime={runtime} />
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 8 }}>
        {!activeId ? (
          <div style={{ padding: 16, opacity: 0.6 }}>No chat open</div>
        ) : (
          <>
            {messages.filter((m) => m.role !== "system").map((m, i) => (
              <div key={i} style={{ marginBottom: 8 }}>
                <strong>{m.role === "tool" ? `tool:${m.toolName}` : m.role}</strong>
                <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
              </div>
            ))}
            {streaming && (
              <div style={{ marginBottom: 8 }}>
                <strong>assistant</strong>
                <div style={{ whiteSpace: "pre-wrap" }}>{streaming}</div>
              </div>
            )}
          </>
        )}
      </div>
      <div style={{ display: "flex", gap: 4, padding: 8, borderTop: "1px solid var(--zero-border)" }}>
        <input
          style={{ flex: 1 }}
          value={input}
          disabled={!activeId || busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder={activeId ? "Ask Zero..." : "Open a chat to start"}
        />
        <button onClick={() => void send()} disabled={!activeId || busy || !input.trim()}>Send</button>
      </div>
    </div>
  );
}
