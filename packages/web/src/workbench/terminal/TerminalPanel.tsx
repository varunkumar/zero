import { useEffect, useState } from "react";
import type { RpcClient } from "@zero/protocol";
import { TerminalHost } from "./TerminalHost";
import type { PtyStore } from "./store";

export function TerminalPanel(props: { client: RpcClient; ptyStore: PtyStore; theme: "light" | "dark" }) {
  const { ptyStore } = props;
  const [, setVersion] = useState(0);
  useEffect(() => ptyStore.subscribe(() => setVersion((v) => v + 1)), [ptyStore]);

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
          >
            <span>{s.shell.split("/").at(-1)}</span>
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
