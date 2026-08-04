import { RpcClient, type SocketLike } from "@zero/protocol";

/** A connected RpcClient plus the means to close its underlying socket.
 * `RpcClient` itself exposes no close/dispose method, so callers that need
 * to tear down a connection (e.g. React effect cleanup) use `close()`. */
export interface Connection {
  client: RpcClient;
  close: () => void;
}

export function connect(): Promise<Connection> {
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
