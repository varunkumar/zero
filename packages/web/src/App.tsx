import { useEffect, useRef, useState } from "react";
import type { RpcClient, SessionHelloResult, WorkspaceCapabilities } from "@zero/protocol";
import { connectDaemon, connectLite, shouldUseDaemon, type Connection } from "./connection";
import { createIdbRootStore, type LiteRoot } from "./lite/roots";
import type { DirHandle } from "./lite/browserFs";
import { Landing } from "./lite/Landing";
import { Workbench } from "./workbench/layout/Workbench";

/** File System Access API surface not covered by TypeScript's bundled DOM
 * lib. Kept minimal and local to this file, the only place that calls the
 * picker directly. */
declare global {
  interface DirectoryPickerOptions {
    mode?: "read" | "readwrite";
    id?: string;
  }
  function showDirectoryPicker(
    options?: DirectoryPickerOptions,
  ): Promise<
    DirHandle & {
      queryPermission?(opts: { mode: "read" | "readwrite" }): Promise<PermissionState>;
      requestPermission?(opts: { mode: "read" | "readwrite" }): Promise<PermissionState>;
    }
  >;
}

type Mode = "connecting" | "error" | "landing" | "ready";

export function App() {
  const [mode, setMode] = useState<Mode>("connecting");
  const [client, setClient] = useState<RpcClient | null>(null);
  const [capabilities, setCapabilities] = useState<WorkspaceCapabilities | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; name: string } | undefined>(undefined);

  const closeRef = useRef<(() => void) | null>(null);
  const pendingRootRef = useRef<LiteRoot | null>(null);
  const rootStoreRef = useRef(createIdbRootStore());
  // The root currently backing the live Lite connection (if any), so
  // `handleChangeFolder` can offer it back as "Reopen" on Landing without
  // auto-resuming it the way the initial-mount effect does.
  const currentRootRef = useRef<LiteRoot | null>(null);

  const hasPicker = typeof showDirectoryPicker === "function";

  async function enterLite(conn: Connection) {
    closeRef.current = conn.close;
    const hello = await conn.client.request<SessionHelloResult>("session/hello");
    setClient(conn.client);
    setCapabilities(hello.capabilities);
    setMode("ready");
  }

  useEffect(() => {
    let cancelled = false;

    if (shouldUseDaemon(location.search, import.meta.env.VITE_ZERO_TOKEN)) {
      connectDaemon()
        .then(async (conn) => {
          closeRef.current = conn.close;
          if (cancelled) {
            // StrictMode double-invoked this effect and the first run was
            // cleaned up before connect() resolved; close this now-orphaned
            // connection instead of leaking it.
            conn.close();
            return;
          }
          const hello = await conn.client.request<SessionHelloResult>("session/hello");
          if (cancelled) {
            conn.close();
            return;
          }
          setClient(conn.client);
          setCapabilities(hello.capabilities);
          setMode("ready");
        })
        .catch((e: unknown) => {
          if (!cancelled) {
            setConnectError(e instanceof Error ? e.message : String(e));
            setMode("error");
          }
        });
      return () => {
        cancelled = true;
        closeRef.current?.();
      };
    }

    // Lite mode: never opens a WebSocket. Show Landing, and in the
    // background look for a previously opened root to auto-open (permission
    // already granted) or offer to reopen (permission needs re-confirming).
    setMode("landing");
    void (async () => {
      const roots = await rootStoreRef.current.list();
      for (const root of roots) {
        if (cancelled) return;
        const state = await root.handle.queryPermission?.({ mode: "readwrite" });
        if (cancelled) return;
        if (state === "granted") {
          const conn = connectLite(root.handle, root.name, root.id);
          const hello = await conn.client.request<SessionHelloResult>("session/hello");
          if (cancelled) {
            conn.close();
            return;
          }
          closeRef.current = conn.close;
          currentRootRef.current = root;
          setClient(conn.client);
          setCapabilities(hello.capabilities);
          setMode("ready");
          return;
        }
        if (state === "prompt" && !pendingRootRef.current) {
          pendingRootRef.current = root;
          setPending({ id: root.id, name: root.name });
        }
      }
    })();

    return () => {
      cancelled = true;
      closeRef.current?.();
    };
  }, []);

  async function handleOpen() {
    const handle = await showDirectoryPicker({ mode: "readwrite", id: "zero-lite" });
    const id = crypto.randomUUID();
    const root: LiteRoot = { id, name: handle.name, handle };
    await rootStoreRef.current.save(root);
    currentRootRef.current = root;
    await enterLite(connectLite(handle, root.name, root.id));
  }

  async function handleReopen() {
    const root = pendingRootRef.current;
    if (!root) return;
    const state = await root.handle.requestPermission?.({ mode: "readwrite" });
    if (state !== "granted") return;
    currentRootRef.current = root;
    await enterLite(connectLite(root.handle, root.name, root.id));
  }

  /** `workspace.changeFolder` (Lite only, Task 11): close the live connection
   * and drop back to Landing without re-running the mount-time auto-open
   * effect (it only ever fires once, so returning to "landing" alone
   * couldn't re-trigger it anyway) — but still offer the folder just closed
   * back via "Reopen" rather than silently forgetting it. */
  function handleChangeFolder() {
    closeRef.current?.();
    closeRef.current = null;
    setClient(null);
    setCapabilities(null);
    const root = currentRootRef.current;
    currentRootRef.current = null;
    if (root) {
      pendingRootRef.current = root;
      setPending({ id: root.id, name: root.name });
    }
    setMode("landing");
  }

  if (mode === "error") {
    return <div style={{ padding: 16, color: "crimson" }}>Failed to connect: {connectError}</div>;
  }
  if (mode === "landing") {
    return (
      <Landing
        hasPicker={hasPicker}
        pending={pending}
        onOpen={() => void handleOpen()}
        onReopen={pending ? () => void handleReopen() : undefined}
      />
    );
  }
  if (mode !== "ready" || !client || !capabilities) {
    return <div style={{ padding: 16 }}>Connecting…</div>;
  }

  return <Workbench client={client} capabilities={capabilities} onChangeFolder={handleChangeFolder} />;
}
