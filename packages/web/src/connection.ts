import { RpcClient, type SocketLike } from "@zero/protocol";

export function connect(): Promise<RpcClient> {
  const params = new URLSearchParams(location.search);
  const base = import.meta.env.VITE_ZERO_URL ?? `ws://${location.host}`;
  const token = params.get("token") ?? import.meta.env.VITE_ZERO_TOKEN ?? "";
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}/rpc?token=${token}`);
    const socket: SocketLike = { send: (d) => ws.send(d), onmessage: null };
    ws.onmessage = (e) => socket.onmessage?.(String(e.data));
    ws.onopen = () => resolve(new RpcClient(socket));
    ws.onerror = () => reject(new Error("daemon unreachable"));
  });
}
