import { z } from "zod";
import { parseMessage, ProtocolError } from "@zero/protocol";

export interface RpcCtx { ws: unknown }
type Handler = { schema: z.ZodType<unknown>; fn: (params: unknown, ctx?: RpcCtx) => Promise<unknown> };

export class RpcServer {
  #methods = new Map<string, Handler>();
  #notifications = new Map<string, (params: unknown) => void>();

  register<P, R>(method: string, schema: z.ZodType<P>, fn: (params: P, ctx?: RpcCtx) => Promise<R>) {
    this.#methods.set(method, { schema, fn: fn as Handler["fn"] });
  }

  /** Registers a handler for client-sent notifications (messages with a
   * `method` but no `id` — no response is ever sent back for these). */
  registerNotification(method: string, fn: (params: unknown) => void) {
    this.#notifications.set(method, fn);
  }

  async dispatch(raw: string, ctx?: RpcCtx): Promise<string | null> {
    let id: number | null = null;
    try {
      const msg = parseMessage(raw);
      if (!("method" in msg)) return null;
      if (!("id" in msg)) {
        this.#notifications.get(msg.method)?.(msg.params);
        return null;
      }
      id = msg.id;
      const handler = this.#methods.get(msg.method);
      if (!handler) return respondError(id, -32601, `unknown method ${msg.method}`);
      const params = handler.schema.safeParse(msg.params);
      if (!params.success) return respondError(id, -32602, "invalid params");
      const result = await handler.fn(params.data, ctx);
      return JSON.stringify({ jsonrpc: "2.0", id, result });
    } catch (e) {
      if (e instanceof ProtocolError) return respondError(id ?? 0, -32700, e.message);
      return respondError(id ?? 0, -32000, e instanceof Error ? e.message : "internal error");
    }
  }
}

function respondError(id: number, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}
