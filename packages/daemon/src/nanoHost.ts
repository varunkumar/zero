import type { ChatMessage, ChatToolSpec, ChatDelta } from "@zero/core";

export type RequestSocketFn = (ws: unknown, method: string, params?: unknown) => Promise<unknown>;

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
    let aborted = false;
    let failure: Error | null = null;

    this.#deltaListeners.set(requestId, (delta) => {
      pending.push(delta);
      const w = wake; wake = null; w?.();
    });

    const done = this.requestSocket(ws, "nano/chat", { requestId, messages, tools })
      .catch((e: unknown) => { failure = e instanceof Error ? e : new Error(String(e)); })
      .finally(() => { finished = true; const w = wake; wake = null; w?.(); });

    // Abort has to both unpark the wait loop (nothing else would, since the
    // browser's reverse request may never settle once it is mid-generation)
    // and tell the browser to stop generating, rather than just leaving it
    // to burn tokens into a stream nobody reads.
    const onAbort = () => {
      aborted = true;
      finished = true;
      // Fire-and-forget, and never let a dead socket's failure (sync throw
      // or rejection) escape into the abort event dispatch.
      try {
        void Promise.resolve(this.requestSocket(ws, "nano/cancel", { requestId })).catch(() => {});
      } catch { /* socket already gone */ }
      const w = wake; wake = null; w?.();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort);

    try {
      while (true) {
        if (pending.length) { yield pending.shift()!; continue; }
        if (finished || signal.aborted) break;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
      // On abort, return promptly: `done` may never settle.
      if (!aborted && !signal.aborted) {
        await done;
        if (failure) throw failure;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.#deltaListeners.delete(requestId);
    }
  }
}
