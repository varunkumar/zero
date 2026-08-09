import type { ChatSessionSummary } from "@zero/protocol";

export class ChatStore {
  #sessions: ChatSessionSummary[] = [];
  #activeId: string | null = null;
  #listeners = new Set<() => void>();

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  getSessions(): ChatSessionSummary[] {
    return this.#sessions;
  }

  getActiveId(): string | null {
    return this.#activeId;
  }

  setSessions(sessions: ChatSessionSummary[]): void {
    this.#sessions = sessions;
    // Two cases land here with a stale/absent activeId: the very first
    // `chat/list` response after mount (activeId starts null) and a list
    // refresh where the previously-active session is gone. Either way,
    // falling back to null would leave a perfectly loadable session sitting
    // in the dropdown with nothing selected underneath it - the dropdown's
    // native "select first option by default" rendering then makes it
    // *look* selected, but ChatPanel's `chat/get` effect never fires
    // (guarded on activeId), so the messages just never load. Default to
    // the first session instead, same as `addSession` already does.
    if (!this.#activeId || !sessions.some((s) => s.id === this.#activeId)) {
      this.#activeId = sessions[0]?.id ?? null;
    }
    this.#notify();
  }

  setActive(id: string): void {
    if (!this.#sessions.some((s) => s.id === id)) return;
    this.#activeId = id;
    this.#notify();
  }

  addSession(session: ChatSessionSummary): void {
    this.#sessions = [session, ...this.#sessions];
    this.#activeId = session.id;
    this.#notify();
  }

  removeSession(id: string): void {
    const idx = this.#sessions.findIndex((s) => s.id === id);
    if (idx === -1) return;
    this.#sessions = this.#sessions.filter((s) => s.id !== id);
    if (this.#activeId === id) {
      this.#activeId = this.#sessions[idx]?.id ?? this.#sessions[idx - 1]?.id ?? null;
    }
    this.#notify();
  }

  touchSession(id: string, title?: string): void {
    this.#sessions = this.#sessions.map((s) => (s.id === id ? { ...s, title: title ?? s.title, updatedAt: Date.now() } : s));
    this.#notify();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
}
