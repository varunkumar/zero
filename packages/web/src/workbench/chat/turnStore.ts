import type { ChatTurnEvent } from "@zero/protocol";

/** Fans out `chat/turnEvent` notifications by `turnId`, mirroring
 * `PtyStore`'s per-key listener-set pattern (see ../terminal/store.ts). Each
 * in-flight turn gets its own listener set so multiple chat sessions can
 * stream concurrently without cross-talk. */
export class TurnStore {
  #listeners = new Map<string, Set<(event: ChatTurnEvent) => void>>();

  onEvent(turnId: string, listener: (event: ChatTurnEvent) => void): () => void {
    let set = this.#listeners.get(turnId);
    if (!set) {
      set = new Set();
      this.#listeners.set(turnId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
    };
  }

  handleEvent(turnId: string, event: ChatTurnEvent): void {
    for (const listener of this.#listeners.get(turnId) ?? []) listener(event);
  }
}
