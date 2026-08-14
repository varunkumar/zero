import { parseMessage } from "./messages";

export interface SocketLike {
  send(data: string): void;
  onmessage: ((data: string) => void) | null;
}

export class RpcClient {
  #next = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #notify: ((method: string, params: unknown) => void) | null = null;
  #requestHandlers = new Map<string, (params: unknown) => Promise<unknown>>();

  constructor(private socket: SocketLike) {
    socket.onmessage = (raw) => {
      const msg = parseMessage(raw);
      if ("id" in msg && ("result" in msg || "error" in msg)) {
        const pending = this.#pending.get(msg.id);
        if (!pending) return;
        this.#pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message));
        else pending.resolve(msg.result);
      } else if ("id" in msg && "method" in msg) {
        void this.#handleIncomingRequest(msg.id, msg.method, msg.params);
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

  /** Fire-and-forget: sends `{method, params}` with no `id`. */
  notify(method: string, params?: unknown) {
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  onNotification(handler: (method: string, params: unknown) => void) { this.#notify = handler; }

  /** Registers a handler for requests the *other end* sends to us (reverse-RPC:
   * the daemon calling into this client). Unregistered methods get an
   * unknown-method error response, matching RpcServer's behavior. */
  onRequest(method: string, handler: (params: unknown) => Promise<unknown>) {
    this.#requestHandlers.set(method, handler);
  }

  async #handleIncomingRequest(id: number, method: string, params: unknown) {
    const handler = this.#requestHandlers.get(method);
    if (!handler) {
      this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } }));
      return;
    }
    try {
      const result = await handler(params);
      this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
    } catch (e) {
      this.socket.send(JSON.stringify({
        jsonrpc: "2.0", id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) },
      }));
    }
  }
}
