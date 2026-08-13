import type { ChatMessage, ChatToolSpec, ChatDelta } from "@zero/core";

export type RequestSocketFn = <R>(ws: unknown, method: string, params?: unknown) => Promise<R>;

/** Tracks which connected browser tab(s) can answer reverse `nano/chat`
 * calls, always routing to the most-recently-registered (foreground) one.
 * Web clients register while visible and unregister on hidden/close, so
 * closing or backgrounding the active tab hands off to another open one
 * instead of killing the bridge. */
export class NanoHostRegistry {
  #sockets: unknown[] = [];
  #deltaListeners = new Map<string, (delta: ChatDelta) => void>();

  constructor(private requestSocket: RequestSocketFn) {}

  register(ws: unknown) {
    this.#sockets = this.#sockets.filter((s) => s !== ws);
    this.#sockets.push(ws);
  }

  unregister(ws: unknown) {
    this.#sockets = this.#sockets.filter((s) => s !== ws);
  }

  available(): boolean {
    return this.#sockets.length > 0;
  }

  handleChatDelta(params: { requestId: string; delta: ChatDelta }) {
    this.#deltaListeners.get(params.requestId)?.(params.delta);
  }

  async *chat(messages: ChatMessage[], tools: ChatToolSpec[], signal: AbortSignal): AsyncIterable<ChatDelta> {
    const ws = this.#sockets.at(-1);
    if (!ws) throw new Error("no nano host connected");

    const requestId = crypto.randomUUID();
    const pending: ChatDelta[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    let failure: Error | null = null;

    this.#deltaListeners.set(requestId, (delta) => {
      pending.push(delta);
      const w = wake; wake = null; w?.();
    });

    const done = this.requestSocket<{ done: true }>(ws, "nano/chat", { requestId, messages, tools })
      .catch((e: unknown) => { failure = e instanceof Error ? e : new Error(String(e)); })
      .finally(() => { finished = true; const w = wake; wake = null; w?.(); });

    try {
      while (true) {
        if (pending.length) { yield pending.shift()!; continue; }
        if (finished || signal.aborted) break;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
      await done;
      if (failure) throw failure;
    } finally {
      this.#deltaListeners.delete(requestId);
    }
  }
}
