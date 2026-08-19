import type { TodoEntry } from "@zero/protocol";
import type { Workspace } from "../../workspace";

export type { TodoEntry } from "@zero/protocol";

export interface TodoScannerStatus {
  ready: boolean;
  indexing: boolean;
  fileCount: number;
  lastError?: string;
}

const MARKER_RE = /\b(TODO|FIXME|HACK)\b:?\s*(.*)/;

export class TodoScanner {
  #workspace: Workspace;
  #entries = new Map<string, TodoEntry[]>();
  #indexing = false;
  #ready = false;
  #lastError?: string;
  #debounce = new Map<string, ReturnType<typeof setTimeout>>();
  #fullScanPromise: Promise<void> | null = null;
  /** Paths changed while a full scan was in flight; re-scanned after it settles. */
  #pendingPaths = new Set<string>();

  constructor(opts: { workspace: Workspace }) {
    this.#workspace = opts.workspace;
  }

  status(): TodoScannerStatus {
    return {
      ready: this.#ready,
      indexing: this.#indexing,
      fileCount: this.#entries.size,
      lastError: this.#lastError,
    };
  }

  list(): TodoEntry[] {
    return [...this.#entries.values()].flat();
  }

  at(path: string): TodoEntry[] {
    return this.#entries.get(path) ?? [];
  }

  startFullScan(): void {
    void this.runFullScan();
  }

  async runFullScan(): Promise<void> {
    if (this.#fullScanPromise) return this.#fullScanPromise;
    this.#fullScanPromise = this.#doFullScan();
    try {
      await this.#fullScanPromise;
    } finally {
      this.#fullScanPromise = null;
      const pending = [...this.#pendingPaths];
      this.#pendingPaths.clear();
      for (const p of pending) {
        await this.#scanPath(p);
      }
    }
  }

  async #doFullScan(): Promise<void> {
    this.#indexing = true;
    try {
      const tree = await this.#workspace.tree();
      const next = new Map<string, TodoEntry[]>();
      for (const entry of tree) {
        if (entry.kind !== "file") continue;
        try {
          const found = await this.#scanFile(entry.path);
          if (found.length > 0) next.set(entry.path, found);
        } catch {
          // Unreadable file (binary/permissions/etc): skip, not fatal to the scan.
        }
      }
      this.#entries = next;
      this.#ready = true;
      this.#lastError = undefined;
    } catch (e) {
      this.#lastError = e instanceof Error ? e.message : String(e);
    } finally {
      this.#indexing = false;
    }
  }

  onFileChanged(path: string): void {
    const prev = this.#debounce.get(path);
    if (prev) clearTimeout(prev);
    this.#debounce.set(
      path,
      setTimeout(() => {
        this.#debounce.delete(path);
        void this.#scanPath(path);
      }, 150),
    );
  }

  async #scanPath(path: string): Promise<void> {
    // Avoid racing the live map against a full rebuild; queue for after.
    if (this.#fullScanPromise) {
      this.#pendingPaths.add(path);
      return;
    }
    try {
      const found = await this.#scanFile(path);
      if (found.length > 0) this.#entries.set(path, found);
      else this.#entries.delete(path);
    } catch {
      // Deleted or unreadable: drop any stale entries for it.
      this.#entries.delete(path);
    }
  }

  async #scanFile(path: string): Promise<TodoEntry[]> {
    const content = await this.#workspace.read(path);
    const out: TodoEntry[] = [];
    content.split("\n").forEach((line, idx) => {
      const m = line.match(MARKER_RE);
      if (m) out.push({ path, line: idx + 1, kind: m[1] as TodoEntry["kind"], text: m[2].trim() });
    });
    return out;
  }

  /** Test helper: wait until the full scan has finished (ready or errored). */
  async waitUntilReady(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.#ready && !this.#indexing) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`TodoScanner.waitUntilReady timed out after ${timeoutMs}ms`);
  }
}
