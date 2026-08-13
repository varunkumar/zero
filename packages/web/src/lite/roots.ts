import type { DirHandle } from "./browserFs";

/** A directory handle the user has previously opened in Lite mode,
 * plus the permission-query surface real `FileSystemDirectoryHandle`
 * instances expose (not part of the minimal `DirHandle` shape other
 * lite/ modules use, since it's only needed for reopen prompts). */
export interface PermissionQueryableHandle {
  queryPermission?(opts: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(opts: { mode: "read" | "readwrite" }): Promise<PermissionState>;
}

export interface LiteRoot {
  id: string;
  name: string;
  handle: DirHandle & Partial<PermissionQueryableHandle>;
}

export interface RootStore {
  list(): Promise<LiteRoot[]>;
  save(root: LiteRoot): Promise<void>;
  remove(id: string): Promise<void>;
}

/** In-memory `RootStore`: used in tests, and as a fallback where IndexedDB
 * is unavailable. Nothing persists across page loads. */
export function createMemoryRootStore(): RootStore {
  const roots = new Map<string, LiteRoot>();
  return {
    async list() {
      return [...roots.values()];
    },
    async save(root) {
      roots.set(root.id, root);
    },
    async remove(id) {
      roots.delete(id);
    },
  };
}

/** Shared IndexedDB database for all Lite persistence (roots, chat sessions,
 * ...). Bump `LITE_DB_VERSION` and extend `ensureLiteStores` whenever a new
 * object store is added, so every module opening this database - regardless
 * of which one happens to run first - converges on the same schema. */
export const LITE_DB_NAME = "zero-lite";
export const LITE_DB_VERSION = 2;
const STORE_NAME = "roots";

function ensureLiteStores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains("roots")) db.createObjectStore("roots", { keyPath: "id" });
  if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "id" });
}

export function openLiteDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LITE_DB_NAME, LITE_DB_VERSION);
    req.onupgradeneeded = () => ensureLiteStores(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("failed to open zero-lite database"));
  });
}

export function runRequest<T>(store: IDBObjectStore, make: () => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = make();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexeddb request failed"));
  });
}

/** `RootStore` backed by IndexedDB (database `zero-lite`, object store
 * `roots`, keyed by `id`) so a chosen directory handle survives reloads -
 * the browser re-persists `FileSystemDirectoryHandle` objects transparently
 * via structured clone. */
export function createIdbRootStore(): RootStore {
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
    list() {
      return withStore("readonly", (store) => runRequest<LiteRoot[]>(store, () => store.getAll() as IDBRequest<LiteRoot[]>));
    },
    async save(root) {
      await withStore("readwrite", (store) => runRequest(store, () => store.put(root)));
    },
    async remove(id) {
      await withStore("readwrite", (store) => runRequest(store, () => store.delete(id)));
    },
  };
}
