import { randomBytes } from "node:crypto";
import { RpcServer } from "./rpc";

export interface DaemonOptions { root: string; port?: number; token?: string; webDist?: string; gatewayPort?: number }

export function createDaemon(opts: DaemonOptions) {
  const token = opts.token ?? randomBytes(16).toString("hex");
  const rpc = new RpcServer();
  const sockets = new Set<Bun.ServerWebSocket<unknown>>();

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
      close(ws) { sockets.delete(ws); },
      async message(ws, raw) {
        const reply = await rpc.dispatch(String(raw));
        if (reply) ws.send(reply);
      },
    },
  });

  return {
    rpc, token, port: server.port as number,
    broadcast(method: string, params: unknown) {
      const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
      for (const ws of sockets) ws.send(msg);
    },
    stop() { server.stop(true); },
  };
}
