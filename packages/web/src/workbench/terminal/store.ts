export interface TerminalSession { sessionId: string; shell: string; name?: string }

export class PtyStore {
  #sessions: TerminalSession[] = [];
  #activeId: string | null = null;
  #listeners = new Set<() => void>();
  #outputListeners = new Map<string, Set<(data: string) => void>>();

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  getSessions(): TerminalSession[] {
    return this.#sessions;
  }

  getActiveId(): string | null {
    return this.#activeId;
  }

  hasSession(sessionId: string): boolean {
    return this.#sessions.some((s) => s.sessionId === sessionId);
  }

  setActive(sessionId: string): void {
    if (!this.hasSession(sessionId)) return;
    this.#activeId = sessionId;
    this.#notify();
  }

  addSession(session: TerminalSession): void {
    if (this.hasSession(session.sessionId)) return;
    this.#sessions.push(session);
    this.#activeId = session.sessionId;
    this.#notify();
  }

  renameSession(sessionId: string, name: string): void {
    const session = this.#sessions.find((s) => s.sessionId === sessionId);
    if (!session) return;
    session.name = name;
    this.#notify();
  }

  removeSession(sessionId: string): void {
    const idx = this.#sessions.findIndex((s) => s.sessionId === sessionId);
    if (idx === -1) return;
    this.#sessions.splice(idx, 1);
    this.#outputListeners.delete(sessionId);
    if (this.#activeId === sessionId) {
      this.#activeId = this.#sessions[idx]?.sessionId ?? this.#sessions[idx - 1]?.sessionId ?? null;
    }
    this.#notify();
  }

  onOutput(sessionId: string, listener: (data: string) => void): () => void {
    let set = this.#outputListeners.get(sessionId);
    if (!set) { set = new Set(); this.#outputListeners.set(sessionId, set); }
    set.add(listener);
    return () => { set!.delete(listener); };
  }

  handleOutput(sessionId: string, data: string): void {
    for (const listener of this.#outputListeners.get(sessionId) ?? []) listener(data);
  }

  handleExit(sessionId: string): void {
    this.removeSession(sessionId);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
}
