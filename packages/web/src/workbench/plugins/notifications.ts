/** Fans a single `client.onNotification` callback out to per-method
 * subscribers. RpcClient.onNotification is single-slot (a second call
 * silently replaces the first), so every consumer of daemon notifications -
 * built-in workbench features and plugin UI alike - must share one
 * registration; this is that shared dispatch point. */
export class NotificationHub {
  #subscribers = new Map<string, Set<(params: unknown) => void>>();

  subscribe(method: string, handler: (params: unknown) => void): () => void {
    let set = this.#subscribers.get(method);
    if (!set) {
      set = new Set();
      this.#subscribers.set(method, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  dispatch(method: string, params: unknown): void {
    for (const handler of this.#subscribers.get(method) ?? []) handler(params);
  }
}
