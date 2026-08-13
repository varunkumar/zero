import { RpcClient, type SocketLike } from "@zero/protocol";
import type { NanoApi } from "@zero/core";
import { BrowserFSWorkspace, type DirHandle } from "./lite/browserFs";
import { createLocalSocket } from "./lite/localRpc";
import { startWatch } from "./lite/watch";
import { LiteChatHost } from "./lite/chatHost";
import { LiteSessionStore, createIdbSessionDb } from "./lite/sessionStore";

/** A connected RpcClient plus the means to close its underlying socket.
 * `RpcClient` itself exposes no close/dispose method, so callers that need
 * to tear down a connection (e.g. React effect cleanup) use `close()`. */
export interface Connection {
  client: RpcClient;
  close: () => void;
}

/** True iff a daemon session token is available - via the `?token=` query
 * param (dev proxy / shared links) or an env-injected token (self-hosted
 * builds). Any non-empty token means daemon mode; its absence means Lite. */
export function shouldUseDaemon(search: string, envToken = ""): boolean {
  const token =
    new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("token") ?? envToken;
  return Boolean(token);
}

export function connectDaemon(): Promise<Connection> {
  const params = new URLSearchParams(location.search);
  const base = import.meta.env.VITE_ZERO_URL ?? `ws://${location.host}`;
  const token = params.get("token") ?? import.meta.env.VITE_ZERO_TOKEN ?? "";
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}/rpc?token=${token}`);
    const socket: SocketLike = { send: (d) => ws.send(d), onmessage: null };
    ws.onmessage = (e) => socket.onmessage?.(String(e.data));
    ws.onopen = () => resolve({ client: new RpcClient(socket), close: () => ws.close() });
    ws.onerror = () => reject(new Error("daemon unreachable"));
  });
}

/** Connects to an in-process Lite "workspace" backed by a browser directory
 * handle: no daemon, no WebSocket. `rootId` identifies the stored
 * `LiteRoot` this connection was opened from (used by callers that need to
 * correlate the live connection back to persisted root state). `watchIntervalMs`
 * is exposed only so tests can drive the fallback poll loop without waiting
 * out the real default; production callers never pass it. */
export function connectLite(
  handle: DirHandle,
  workspaceName: string,
  rootId: string,
  watchIntervalMs?: number,
): Connection {
  const workspace = new BrowserFSWorkspace(handle);
  const store = new LiteSessionStore(rootId, createIdbSessionDb());
  const nanoApi = (globalThis as { LanguageModel?: NanoApi }).LanguageModel;
  const host = new LiteChatHost({
    store,
    fs: workspace,
    folderName: workspaceName,
    nanoApi,
    notify: (method, params) => socket.notify(method, params),
  });
  const socket = createLocalSocket({
    workspaceName,
    fs: workspace,
    extra: (method, params) => {
      if (method.startsWith("chat/")) return host.handle(method, params);
      throw Object.assign(new Error("method not available in lite"), { code: -32601 });
    },
  });
  const client = new RpcClient(socket);
  const watcher = startWatch(workspace, (path) => socket.notify("fs/changed", { path }), {
    root: handle,
    ...(watchIntervalMs !== undefined ? { intervalMs: watchIntervalMs } : {}),
  });
  return {
    client,
    close: () => watcher.stop(),
  };
}
