import { z } from "zod";
import { parseMessage, ProtocolError } from "@zero/protocol";

type Handler = { schema: z.ZodType<unknown>; fn: (params: unknown) => Promise<unknown> };

export class RpcServer {
  #methods = new Map<string, Handler>();

  register<P, R>(method: string, schema: z.ZodType<P>, fn: (params: P) => Promise<R>) {
    this.#methods.set(method, { schema, fn: fn as Handler["fn"] });
  }

  async dispatch(raw: string): Promise<string | null> {
    let id: number | null = null;
    try {
      const msg = parseMessage(raw);
      if (!("method" in msg)) return null;
      if (!("id" in msg)) return null; // client notifications: none yet
      id = msg.id;
      const handler = this.#methods.get(msg.method);
      if (!handler) return respondError(id, -32601, `unknown method ${msg.method}`);
      const params = handler.schema.safeParse(msg.params);
      if (!params.success) return respondError(id, -32602, "invalid params");
      const result = await handler.fn(params.data);
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
