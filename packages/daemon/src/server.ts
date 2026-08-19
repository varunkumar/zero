import { randomBytes } from "node:crypto";
import { parseMessage } from "@zero/protocol";
import { RpcServer } from "./rpc";

export interface DaemonOptions { root: string; port?: number; token?: string; webDist?: string; gatewayPort?: number; pluginsDir?: string }

export function createDaemon(opts: DaemonOptions) {
  const token = opts.token ?? randomBytes(16).toString("hex");
  const rpc = new RpcServer();
  const sockets = new Set<Bun.ServerWebSocket<unknown>>();
  const closeHooks = new Set<(ws: Bun.ServerWebSocket<unknown>) => void>();

  let nextReverseId = 1;
  const reversePending = new Map<number, {
    resolve: (v: unknown) => void; reject: (e: Error) => void; ws: Bun.ServerWebSocket<unknown>;
  }>();

  function requestSocket<R>(ws: Bun.ServerWebSocket<unknown>, method: string, params?: unknown): Promise<R> {
    const id = nextReverseId++;
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise<R>((resolve, reject) =>
      reversePending.set(id, { resolve: resolve as (v: unknown) => void, reject, ws }));
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/rpc") {
        if (url.searchParams.get("token") !== token)
          return new Response("unauthorized", { status: 401 });
        return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      const pluginUiMatch = url.pathname.match(/^\/plugins\/([^/]+)\/ui\.js$/);
      if (pluginUiMatch) {
        if (!opts.pluginsDir) return new Response("not found", { status: 404 });
        const id = pluginUiMatch[1];
        const file = Bun.file(`${opts.pluginsDir}/${id}/ui/dist/index.js`);
        return file.exists().then(
          (ok) => ok
            ? new Response(file, { headers: { "Content-Type": "text/javascript" } })
            : new Response("not found", { status: 404 }),
          () => new Response("not found", { status: 404 }),
        );
      }
      if (opts.webDist) {
        const path = url.pathname === "/" ? "/index.html" : url.pathname;
        const file = Bun.file(opts.webDist + path);
        const index = Bun.file(opts.webDist + "/index.html");
        return file.exists().then(async (ok) => {
          if (ok) return new Response(file);
          if (await index.exists()) return new Response(index);
          return new Response(
            "zero web UI is not built. Run `bun run --filter @zero/web build` (or ./scripts/install.sh) and retry.",
            { status: 500 },
          );
        });
      }
      return new Response("zero daemon", { status: 200 });
    },
    websocket: {
      open(ws) { sockets.add(ws); },
      close(ws) {
        sockets.delete(ws);
        for (const [id, pending] of reversePending) {
          if (pending.ws === ws) {
            reversePending.delete(id);
            pending.reject(new Error("socket closed"));
          }
        }
        for (const hook of closeHooks) hook(ws);
      },
      async message(ws, raw) {
        const str = String(raw);
        let parsed;
        try { parsed = parseMessage(str); } catch { parsed = undefined; }
        // A response-shaped message (has result/error, no method) with no
        // matching registered method dispatch answers one of *our* reverse
        // requests to this socket, not a client-issued call. The pending
        // entry must belong to *this* socket: ids are per-daemon, not
        // per-socket, so another client could otherwise answer (or poison)
        // a request it was never sent. A non-matching socket falls through
        // to ordinary dispatch rather than being dropped.
        if (parsed && !("method" in parsed) && "id" in parsed) {
          const pending = reversePending.get(parsed.id);
          if (pending && pending.ws === ws) {
            reversePending.delete(parsed.id);
            if (parsed.error) pending.reject(new Error(parsed.error.message));
            else pending.resolve(parsed.result);
            return;
          }
        }
        const reply = await rpc.dispatch(str, { ws });
        if (reply) ws.send(reply);
      },
    },
  });

  return {
    rpc, token, port: server.port as number, sockets,
    requestSocket,
    onSocketClose(fn: (ws: Bun.ServerWebSocket<unknown>) => void) { closeHooks.add(fn); },
    broadcast(method: string, params: unknown) {
      const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
      for (const ws of sockets) ws.send(msg);
    },
    stop() { server.stop(true); },
  };
}
