import { useEffect, useRef, useState } from "react";
import type { RpcClient, SessionHelloResult, WorkspaceCapabilities } from "@zero/protocol";
import { connectDaemon, connectLite, probeDaemon, shouldUseDaemon, type Connection } from "./connection";
import { createIdbRootStore, findSameRoot, sortByLastOpened, type LiteRoot } from "./lite/roots";
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
  // Set once a Lite connection is live, so the background daemon probe
  // (finding 4) never yanks the user out of a folder they already opened.
  const liteEnteredRef = useRef(false);

  const hasPicker = typeof showDirectoryPicker === "function";

  async function enterLite(conn: Connection) {
    closeRef.current = conn.close;
    liteEnteredRef.current = true;
    const hello = await conn.client.request<SessionHelloResult>("session/hello");
    setClient(conn.client);
    setCapabilities(hello.capabilities);
    setMode("ready");
  }

  async function goDaemon(cancelledRef: { current: boolean }) {
    try {
      const conn = await connectDaemon();
      closeRef.current = conn.close;
      if (cancelledRef.current || liteEnteredRef.current) {
        // StrictMode double-invoked this effect and the first run was
        // cleaned up before connect() resolved, or the user already opened
        // a Lite folder while this connect was in flight - either way, this
        // connection is now orphaned.
        conn.close();
        return;
      }
      const hello = await conn.client.request<SessionHelloResult>("session/hello");
      if (cancelledRef.current || liteEnteredRef.current) {
        conn.close();
        return;
      }
      setClient(conn.client);
      setCapabilities(hello.capabilities);
      setMode("ready");
    } catch (e) {
      if (!cancelledRef.current && !liteEnteredRef.current) {
        setConnectError(e instanceof Error ? e.message : String(e));
        setMode("error");
      }
    }
  }

  useEffect(() => {
    const cancelledRef = { current: false };

    if (shouldUseDaemon(location.search, import.meta.env.VITE_ZERO_TOKEN)) {
      void goDaemon(cancelledRef);
      return () => {
        cancelledRef.current = true;
        closeRef.current?.();
      };
    }

    // No token in the URL. This is the common Lite case (no daemon running
    // anywhere), but it could also be a daemon-served origin visited
    // without ?token= (finding 4) - probe for that in the background so the
    // honest "Failed to connect" wins over a silent, wrong Lite Landing.
    // Landing renders immediately regardless, so the probe never delays or
    // flashes the common no-daemon case.
    setMode("landing");
    void probeDaemon().then((isDaemon) => {
      if (cancelledRef.current || !isDaemon || liteEnteredRef.current) return;
      void goDaemon(cancelledRef);
    });

    void (async () => {
      const roots = sortByLastOpened(await rootStoreRef.current.list());
      for (const root of roots) {
        if (cancelledRef.current) return;
        const state = await root.handle.queryPermission?.({ mode: "readwrite" });
        if (cancelledRef.current) return;
        if (state === "granted") {
          const updated: LiteRoot = { ...root, lastOpenedAt: Date.now() };
          await rootStoreRef.current.save(updated);
          const conn = connectLite(updated.handle, updated.name, updated.id);
          if (cancelledRef.current) {
            conn.close();
            return;
          }
          currentRootRef.current = updated;
          await enterLite(conn);
          return;
        }
        if (state === "denied") {
          // Stale or revoked - stop offering it on every future boot.
          await rootStoreRef.current.remove(root.id);
          continue;
        }
        if (state === "prompt" && !pendingRootRef.current) {
          pendingRootRef.current = root;
          setPending({ id: root.id, name: root.name });
        }
      }
    })();

    return () => {
      cancelledRef.current = true;
      closeRef.current?.();
    };
  }, []);

  /** True for `showDirectoryPicker()`'s rejection when the user dismisses
   * the picker (Esc, Cancel) - per spec this stays silently on Landing,
   * not an error screen. Checked structurally (not `instanceof
   * DOMException`) since `DOMException` does not reliably subclass `Error`
   * across engines, and this also has to recognize a plain `{ name:
   * "AbortError" }`-shaped rejection from a test double. */
  function isPickerCancelled(err: unknown): boolean {
    return (
      typeof err === "object" &&
      err !== null &&
      "name" in err &&
      (err as { name?: unknown }).name === "AbortError"
    );
  }

  async function handleOpen() {
    try {
      const handle = await showDirectoryPicker({ mode: "readwrite", id: "zero-lite" });
      const existingRoots = await rootStoreRef.current.list();
      const existing = await findSameRoot(existingRoots, handle);
      const id = existing?.id ?? crypto.randomUUID();
      const root: LiteRoot = { id, name: handle.name, handle, lastOpenedAt: Date.now() };
      await rootStoreRef.current.save(root);
      currentRootRef.current = root;
      await enterLite(connectLite(handle, root.name, root.id));
    } catch (err) {
      if (isPickerCancelled(err)) return;
      setConnectError(err instanceof Error ? err.message : String(err));
      setMode("error");
    }
  }

  async function handleReopen() {
    const root = pendingRootRef.current;
    if (!root) return;
    try {
      const state = await root.handle.requestPermission?.({ mode: "readwrite" });
      if (state !== "granted") return;
      const updated: LiteRoot = { ...root, lastOpenedAt: Date.now() };
      await rootStoreRef.current.save(updated);
      currentRootRef.current = updated;
      await enterLite(connectLite(updated.handle, updated.name, updated.id));
    } catch (err) {
      if (isPickerCancelled(err)) return;
      setConnectError(err instanceof Error ? err.message : String(err));
      setMode("error");
    }
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
