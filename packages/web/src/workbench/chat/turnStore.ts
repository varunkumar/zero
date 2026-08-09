import type { ChatTurnEvent } from "@zero/protocol";

/** Fans out `chat/turnEvent` notifications by `turnId`, mirroring
 * `PtyStore`'s per-key listener-set pattern (see ../terminal/store.ts). Each
 * in-flight turn gets its own listener set so multiple chat sessions can
 * stream concurrently without cross-talk. */
export class TurnStore {
  #listeners = new Map<string, Set<(event: ChatTurnEvent) => void>>();
  #activeTurns = new Set<string>();

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
    // Track active turns: add on any non-terminal event, remove on done/error
    if (event.type === "done" || event.type === "error") {
      this.#activeTurns.delete(turnId);
    } else {
      this.#activeTurns.add(turnId);
    }

    for (const listener of this.#listeners.get(turnId) ?? []) listener(event);
  }

  isActive(turnId: string): boolean {
    return this.#activeTurns.has(turnId);
  }
}
