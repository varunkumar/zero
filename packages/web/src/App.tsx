import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import type { RpcClient, FsReadResult, FsChangedEvent } from "@zero/protocol";
import { connect } from "./connection";
import { FileTree } from "./FileTree";
import { Editor } from "./Editor";
import { createCompletion } from "./completionSetup";
import { StatusPill } from "./StatusPill";
import { Settings } from "./Settings";

export function App() {
  const [client, setClient] = useState<RpcClient | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const openPathRef = useRef<string | null>(null);
  openPathRef.current = openPath;
  const viewRef = useRef<EditorView | undefined>(undefined);
  // Every file opened this session, keyed by path — used both as context for
  // completions (Finding 3) and, combined with lastWriteRef below, to avoid
  // re-reading a file right after we wrote it ourselves (Finding 1).
  const buffersRef = useRef(new Map<string, string>());
  // The most recent successful fs/write we issued, not yet confirmed as
  // "seen" via its own fs/changed echo. Cleared after that echo is consumed
  // once, so a genuine subsequent external change still triggers a re-read.
  const lastWriteRef = useRef<{ path: string; content: string } | null>(null);
  const completionRef = useRef(
    createCompletion(
      () => viewRef.current,
      () => openPathRef.current ?? "",
    ),
  );

  useEffect(() => {
    let cancelled = false;
    let close: (() => void) | null = null;
    connect()
      .then((conn) => {
        close = conn.close;
        if (cancelled) {
          // StrictMode double-invoked this effect and the first run was cleaned up
          // before connect() resolved; close this now-orphaned connection instead
          // of leaking it.
          conn.close();
          return;
        }
        setClient(conn.client);
      })
      .catch((e: unknown) => {
        if (!cancelled) setConnectError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
      close?.();
    };
  }, []);

  const openFile = useCallback(
    (path: string, activeClient: RpcClient) => {
      activeClient
        .request<FsReadResult>("fs/read", { path })
        .then((res) => {
          setOpenPath(path);
          setContent(res.content);
          setStatus("");
          buffersRef.current.set(path, res.content);
          completionRef.current.buffers.setBuffers(
            [...buffersRef.current].map(([p, content]) => ({ path: p, content })),
          );
        })
        .catch((e: unknown) => {
          setStatus(`error: ${e instanceof Error ? e.message : String(e)}`);
        });
    },
    [],
  );

  const onEditorChange = useCallback((text: string) => {
    const path = openPathRef.current;
    if (!path) return;
    buffersRef.current.set(path, text);
    completionRef.current.buffers.setBuffers(
      [...buffersRef.current].map(([p, content]) => ({ path: p, content })),
    );
  }, []);

  useEffect(() => {
    if (!client) return;
    client.onNotification((method, params) => {
      if (method !== "fs/changed") return;
      const { path } = params as FsChangedEvent;
      if (path !== openPathRef.current) return;
      const lastWrite = lastWriteRef.current;
      if (lastWrite && lastWrite.path === path) {
        // This is (almost certainly) the fs/changed echo of our own write:
        // the daemon's fs.watch doesn't distinguish self-writes from
        // external ones, but the content it now holds is exactly what's
        // already in the editor, so re-reading (and destroying editor
        // state) would be pure loss. Consume the suppression once; a
        // genuine external change after this still gets picked up below.
        lastWriteRef.current = null;
        return;
      }
      openFile(path, client);
    });
  }, [client, openFile]);

  const onSave = useCallback(
    (text: string) => {
      const path = openPathRef.current;
      if (!client || !path) return;
      client
        .request("fs/write", { path, content: text })
        .then(() => {
          lastWriteRef.current = { path, content: text };
          setStatus(`saved ${path}`);
        })
        .catch((e: unknown) => {
          setStatus(`error: ${e instanceof Error ? e.message : String(e)}`);
        });
    },
    [client],
  );

  if (connectError) {
    return <div style={{ padding: 16, color: "crimson" }}>Failed to connect: {connectError}</div>;
  }
  if (!client) {
    return <div style={{ padding: 16 }}>Connecting…</div>;
  }

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ width: 240, borderRight: "1px solid #ccc", flexShrink: 0 }}>
        <FileTree client={client} activePath={openPath} onOpen={(path) => openFile(path, client)} />
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div
          style={{
            padding: "4px 8px",
            borderBottom: "1px solid #ccc",
            fontSize: 12,
            color: "#555",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <span>
            {openPath ?? "no file open"} {status}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <StatusPill engine={completionRef.current.engine} />
            <Settings />
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          {openPath !== null ? (
            <Editor
              path={openPath}
              content={content}
              onSave={onSave}
              onChange={onEditorChange}
              requestCompletion={completionRef.current.request}
              onViewChange={(v) => { viewRef.current = v; }}
            />
          ) : (
            <div style={{ padding: 16, color: "#888" }}>Select a file to edit</div>
          )}
        </div>
      </div>
    </div>
  );
}
