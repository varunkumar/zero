import { useEffect, useRef, useState } from "react";
import type { RpcClient } from "@zero/protocol";
import { TerminalHost } from "./TerminalHost";
import type { PtyStore } from "./store";

/** Replaces `window.prompt()` for the tab-rename flow, which Tauri's
 * WKWebView on macOS doesn't implement (wry doesn't wire up the
 * `WKUIDelegate` methods it needs) - same fix as FileTreePanel's inline
 * create/rename inputs, kept local here since this is the only other
 * `window.prompt()` call left in the workbench. */
function InlineRenameInput(props: { initialValue: string; onSubmit: (value: string) => void; onCancel: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const settledRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      defaultValue={props.initialValue}
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          settledRef.current = true;
          props.onSubmit(e.currentTarget.value);
        } else if (e.key === "Escape") {
          settledRef.current = true;
          props.onCancel();
        }
      }}
      onBlur={(e) => {
        if (settledRef.current) return;
        settledRef.current = true;
        props.onSubmit(e.currentTarget.value);
      }}
      style={{
        width: 90,
        font: "inherit",
        color: "var(--zero-editor-fg)",
        background: "var(--zero-editor-bg)",
        border: "1px solid var(--zero-accent)",
        borderRadius: 2,
        padding: "0 4px",
      }}
    />
  );
}

export function TerminalPanel(props: { client: RpcClient; ptyStore: PtyStore; theme: "light" | "dark" }) {
  const { ptyStore } = props;
  const [, setVersion] = useState(0);
  useEffect(() => ptyStore.subscribe(() => setVersion((v) => v + 1)), [ptyStore]);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const sessions = ptyStore.getSessions();
  const activeId = ptyStore.getActiveId();

  async function newTerminal(): Promise<void> {
    const { sessionId, shell } = await props.client.request<{ sessionId: string; shell: string }>(
      "pty/open", { cols: 80, rows: 24 });
    ptyStore.addSession({ sessionId, shell });
  }

  function closeTerminal(sessionId: string): void {
    void props.client.request("pty/close", { sessionId });
    ptyStore.removeSession(sessionId);
  }

  function submitRename(sessionId: string, name: string): void {
    setRenamingId(null);
    if (!name.trim()) return;
    ptyStore.renameSession(sessionId, name.trim());
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--zero-editor-bg)", color: "var(--zero-editor-fg)" }}>
      <div className="zero-tabstrip" role="tablist">
        {sessions.map((s) => (
          <div
            key={s.sessionId}
            className="zero-tab"
            role="tab"
            aria-selected={s.sessionId === activeId}
            onClick={() => ptyStore.setActive(s.sessionId)}
            onDoubleClick={() => setRenamingId(s.sessionId)}
            title="Double-click to rename"
          >
            {renamingId === s.sessionId ? (
              <InlineRenameInput
                initialValue={s.name ?? s.shell.split("/").at(-1) ?? ""}
                onSubmit={(value) => submitRename(s.sessionId, value)}
                onCancel={() => setRenamingId(null)}
              />
            ) : (
              <span>{s.name ?? s.shell.split("/").at(-1)}</span>
            )}
            <button className="zero-tab-close" aria-label={`Close terminal ${s.sessionId}`}
              onClick={(e) => { e.stopPropagation(); closeTerminal(s.sessionId); }}>
              ×
            </button>
          </div>
        ))}
        <button aria-label="New terminal" onClick={() => void newTerminal()} style={{ marginLeft: 4 }}>+</button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {sessions.length === 0 ? (
          <div style={{ padding: 16, opacity: 0.6 }}>No terminals open</div>
        ) : (
          sessions.map((s) => (
            <TerminalHost key={s.sessionId} client={props.client} ptyStore={ptyStore}
              sessionId={s.sessionId} visible={s.sessionId === activeId} theme={props.theme} />
          ))
        )}
      </div>
    </div>
  );
}
