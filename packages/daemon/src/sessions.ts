import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatSessionSummary } from "@zero/protocol";
import { sessionsDir } from "./paths";

export class InvalidSessionIdError extends Error {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StoredSession { id: string; title: string; updatedAt: number; messages: ChatMessage[]; seq: number }

let writeCounter = 0;

export class SessionStore {
  constructor(private workspaceRoot: string) {}

  #dir(): string {
    return sessionsDir(this.workspaceRoot);
  }

  #path(id: string): string {
    if (!UUID_RE.test(id)) throw new InvalidSessionIdError(id);
    return join(this.#dir(), `${id}.json`);
  }

  async #read(id: string): Promise<StoredSession | null> {
    const path = this.#path(id);
    try {
      const data = JSON.parse(await fs.readFile(path, "utf8")) as StoredSession;
      return { ...data, seq: data.seq ?? 0 };
    } catch {
      return null;
    }
  }

  async #write(session: StoredSession): Promise<void> {
    session.seq = ++writeCounter;
    const path = this.#path(session.id);
    await fs.mkdir(this.#dir(), { recursive: true });
    await fs.writeFile(path, JSON.stringify(session, null, 2), "utf8");
  }

  async create(title?: string): Promise<string> {
    const id = randomUUID();
    await this.#write({ id, title: title ?? "New chat", updatedAt: Date.now(), messages: [], seq: 0 });
    return id;
  }

  async list(): Promise<ChatSessionSummary[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.#dir());
    } catch {
      return [];
    }
    const ids = files
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .filter((id) => UUID_RE.test(id));
    const sessions = await Promise.all(ids.map((id) => this.#read(id)));
    return sessions
      .filter((s): s is StoredSession => s !== null)
      .sort((a, b) => {
        const timeDiff = b.updatedAt - a.updatedAt;
        if (timeDiff !== 0) return timeDiff;
        return b.seq - a.seq;
      })
      .map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, messageCount: s.messages.length }));
  }

  async get(id: string): Promise<{ id: string; title: string; messages: ChatMessage[] } | null> {
    const s = await this.#read(id);
    return s && { id: s.id, title: s.title, messages: s.messages };
  }

  /** The caller (AgentRuntime, via chat/append) always sends the full,
   * authoritative message list for the session — compaction shrinks
   * history, so this replaces rather than truly appends. The store stays a
   * dumb persistence layer with no opinion on that. */
  async append(id: string, messages: ChatMessage[]): Promise<void> {
    const existing = await this.#read(id);
    if (!existing) return; // session was deleted (or never existed): don't resurrect it
    await this.#write({ id, title: existing.title, updatedAt: Date.now(), messages, seq: 0 });
  }

  async rename(id: string, title: string): Promise<void> {
    const existing = await this.#read(id);
    if (!existing) return;
    await this.#write({ ...existing, title });
  }

  async delete(id: string): Promise<void> {
    const path = this.#path(id);
    try {
      await fs.unlink(path);
    } catch {
      // already gone
    }
  }
}
