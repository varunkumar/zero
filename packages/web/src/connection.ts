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

/** True iff the current origin's `/rpc` endpoint is being served by a Zero
 * daemon, independent of whether *this* browser has a valid token for it.
 *
 * `packages/daemon/src/server.ts` rejects any `/rpc` request whose token
 * doesn't match with an explicit HTTP 401, *before* attempting the
 * WebSocket upgrade - so a plain unauthenticated `fetch` reproduces that
 * check without needing a token. A static Lite origin (Cloudflare Pages)
 * has no such handler: its SPA fallback serves `index.html` (200) for any
 * unknown path, and "nothing is listening at all" fails the fetch outright.
 * 401 is therefore the one signal that means "a daemon owns this origin" -
 * used by `shouldUseDaemon`'s async counterpart in `App.tsx` to keep a
 * daemon-served page that was opened without `?token=` on the honest
 * "Failed to connect" path instead of silently falling into Lite Landing. */
export type DaemonProbeFetch = (url: string, init: { signal: AbortSignal }) => Promise<{ status: number }>;

export function probeDaemon(opts?: { fetch?: DaemonProbeFetch; timeoutMs?: number; url?: string }): Promise<boolean> {
  const doFetch = opts?.fetch ?? (fetch as DaemonProbeFetch);
  const timeoutMs = opts?.timeoutMs ?? 400;
  const url = opts?.url ?? `${daemonHttpBase()}/rpc`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return doFetch(url, { signal: controller.signal })
    .then((res) => res.status === 401)
    .catch(() => false)
    .finally(() => clearTimeout(timer));
}

function daemonHttpBase(): string {
  const host = typeof location !== "undefined" ? location.host : "";
  const wsBase = import.meta.env.VITE_ZERO_URL ?? `ws://${host}`;
  return wsBase.replace(/^ws/, "http");
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
    // Order matters only in that all three must happen: stop the poll/observer
    // so no further fs/changed fires, abort any in-flight chat turn (and drop
    // pooled runtimes) so an approval or tool write granted after the user
    // has switched folders can't land against the folder they left, then cut
    // the socket's onmessage so nothing further - from either of the above,
    // or a stray notify() racing this call - reaches the (about to be
    // discarded) RpcClient.
    close: () => {
      watcher.stop();
      host.dispose();
      socket.onmessage = null;
    },
  };
}
