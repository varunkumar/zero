import type { ChatMessage, ChatSessionSummary } from "@zero/protocol";
import { openLiteDb, runRequest } from "./roots";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORE_NAME = "sessions";

interface StoredSession {
  id: string;
  rootId: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
  seq: number;
}

export interface SessionDb {
  get(id: string): Promise<StoredSession | null>;
  put(session: StoredSession): Promise<void>;
  delete(id: string): Promise<void>;
  list(): Promise<StoredSession[]>;
}

/** In-memory `SessionDb`: used in tests, and as a fallback where IndexedDB
 * is unavailable. Nothing persists across page loads. */
export function createMemorySessionDb(): SessionDb {
  const sessions = new Map<string, StoredSession>();
  let writeCounter = 0;
  return {
    async get(id) {
      return sessions.get(id) ?? null;
    },
    async put(session) {
      sessions.set(session.id, { ...session, seq: ++writeCounter });
    },
    async delete(id) {
      sessions.delete(id);
    },
    async list() {
      return [...sessions.values()];
    },
  };
}

/** `SessionDb` backed by IndexedDB (database `zero-lite`, object store
 * `sessions`, keyed by `id`) so chat history survives reloads. Shares the
 * database with `RootStore` - see `openLiteDb` in `./roots`. */
export function createIdbSessionDb(): SessionDb {
  let writeCounter = 0;
  async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<T>): Promise<T> {
    const db = await openLiteDb();
    try {
      const tx = db.transaction(STORE_NAME, mode);
      const result = await run(tx.objectStore(STORE_NAME));
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("indexeddb transaction failed"));
      });
      return result;
    } finally {
      db.close();
    }
  }

  return {
    async get(id) {
      const result = await withStore("readonly", (store) =>
        runRequest<StoredSession | undefined>(store, () => store.get(id) as IDBRequest<StoredSession | undefined>));
      return result ?? null;
    },
    async put(session) {
      await withStore("readwrite", (store) =>
        runRequest(store, () => store.put({ ...session, seq: ++writeCounter })));
    },
    async delete(id) {
      await withStore("readwrite", (store) => runRequest(store, () => store.delete(id)));
    },
    list() {
      return withStore("readonly", (store) =>
        runRequest<StoredSession[]>(store, () => store.getAll() as IDBRequest<StoredSession[]>));
    },
  };
}

/** Chat session persistence for one Lite root. Every record carries the
 * `rootId` it belongs to; `list`/`get` silently ignore records from other
 * roots so switching workspaces never leaks another workspace's chat
 * history through a shared `SessionDb`. */
export class LiteSessionStore {
  constructor(
    private rootId: string,
    private db: SessionDb,
  ) {}

  #checkId(id: string): void {
    if (!UUID_RE.test(id)) throw new Error(`invalid session id: ${id}`);
  }

  async create(title?: string): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.put({ id, rootId: this.rootId, title: title ?? "New chat", updatedAt: Date.now(), messages: [], seq: 0 });
    return id;
  }

  async list(): Promise<ChatSessionSummary[]> {
    const all = await this.db.list();
    return all
      .filter((s) => s.rootId === this.rootId)
      .sort((a, b) => b.updatedAt - a.updatedAt || b.seq - a.seq)
      .map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, messageCount: s.messages.length }));
  }

  async get(id: string): Promise<{ id: string; title: string; messages: ChatMessage[] } | null> {
    this.#checkId(id);
    const s = await this.db.get(id);
    if (!s || s.rootId !== this.rootId) return null;
    return { id: s.id, title: s.title, messages: s.messages };
  }

  /** The caller (AgentRuntime, via chat/append) always sends the full,
   * authoritative message list for the session - this replaces rather than
   * truly appends, matching the daemon `SessionStore` contract. */
  async append(id: string, messages: ChatMessage[]): Promise<void> {
    this.#checkId(id);
    const existing = await this.db.get(id);
    if (!existing || existing.rootId !== this.rootId) return;
    await this.db.put({ ...existing, messages, updatedAt: Date.now() });
  }

  async rename(id: string, title: string): Promise<void> {
    this.#checkId(id);
    const existing = await this.db.get(id);
    if (!existing || existing.rootId !== this.rootId) return;
    await this.db.put({ ...existing, title, updatedAt: Date.now() });
  }

  async delete(id: string): Promise<void> {
    this.#checkId(id);
    const existing = await this.db.get(id);
    if (!existing || existing.rootId !== this.rootId) return;
    await this.db.delete(id);
  }
}
