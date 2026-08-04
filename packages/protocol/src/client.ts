import { parseMessage } from "./messages";

export interface SocketLike {
  send(data: string): void;
  onmessage: ((data: string) => void) | null;
}

export class RpcClient {
  #next = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #notify: ((method: string, params: unknown) => void) | null = null;

  constructor(private socket: SocketLike) {
    socket.onmessage = (raw) => {
      const msg = parseMessage(raw);
      if ("id" in msg && ("result" in msg || "error" in msg)) {
        const pending = this.#pending.get(msg.id);
        if (!pending) return;
        this.#pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message));
        else pending.resolve(msg.result);
      } else if (!("id" in msg)) {
        this.#notify?.(msg.method, msg.params);
      }
    };
  }

  request<R>(method: string, params?: unknown): Promise<R> {
    const id = this.#next++;
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise<R>((resolve, reject) =>
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
  }

  onNotification(handler: (method: string, params: unknown) => void) { this.#notify = handler; }
}
