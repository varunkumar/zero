import type { GraphStatusResult } from "@zero/protocol";
import type { Workspace } from "../../workspace";
import {
  activeLanguages,
  resolveLanguage,
  type GrammarSettings,
} from "./grammars";
import { extractFromSource } from "./extract";
import type { GraphStore } from "./store";

export class GraphIndexer {
  #workspace: Workspace;
  #store: GraphStore;
  #getGrammarSettings: () => Promise<GrammarSettings | undefined>;
  #indexing = false;
  #ready = false;
  #fileCount = 0;
  #lastError?: string;
  #lastOverrides?: GrammarSettings;
  #debounce = new Map<string, ReturnType<typeof setTimeout>>();
  #fullIndexPromise: Promise<void> | null = null;

  constructor(opts: {
    workspace: Workspace;
    store: GraphStore;
    getGrammarSettings: () => Promise<GrammarSettings | undefined>;
  }) {
    this.#workspace = opts.workspace;
    this.#store = opts.store;
    this.#getGrammarSettings = opts.getGrammarSettings;
  }

  status(): GraphStatusResult {
    return {
      ready: this.#ready,
      indexing: this.#indexing,
      fileCount: this.#fileCount,
      nodeCount: this.#store.nodeCount,
      edgeCount: this.#store.edgeCount,
      lastError: this.#lastError,
      languages: activeLanguages(this.#lastOverrides),
    };
  }

  startFullIndex(): void {
    void this.runFullIndex();
  }

  async runFullIndex(): Promise<void> {
    if (this.#fullIndexPromise) return this.#fullIndexPromise;
    this.#fullIndexPromise = this.#doFullIndex();
    try {
      await this.#fullIndexPromise;
    } finally {
      this.#fullIndexPromise = null;
    }
  }

  async #doFullIndex(): Promise<void> {
    this.#indexing = true;
    this.#ready = false;
    try {
      const overrides = await this.#getGrammarSettings();
      this.#lastOverrides = overrides;
      const entries = await this.#workspace.tree();
      const files = entries.filter(
        (e) => e.kind === "file" && resolveLanguage(e.path, overrides),
      );
      this.#store.clear();
      this.#fileCount = 0;
      for (const f of files) {
        await this.#indexPath(f.path, overrides);
        this.#fileCount++;
      }
      this.#ready = true;
      this.#lastError = undefined;
    } catch (e) {
      this.#lastError = e instanceof Error ? e.message : String(e);
      this.#ready = this.#store.nodeCount > 0;
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
        void this.#reindexPath(path);
      }, 150),
    );
  }

  /** Test helper: wait until full index has finished (ready or errored). */
  async waitUntilReady(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = this.status();
      if (s.ready || (s.lastError && !s.indexing)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(
      `GraphIndexer.waitUntilReady timed out after ${timeoutMs}ms: ${JSON.stringify(this.status())}`,
    );
  }

  async #reindexPath(path: string): Promise<void> {
    const overrides = await this.#getGrammarSettings();
    this.#lastOverrides = overrides;
    if (!resolveLanguage(path, overrides)) {
      this.#store.removeFile(path);
      return;
    }
    try {
      await this.#indexPath(path, overrides);
    } catch (e) {
      this.#lastError = `${path}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async #indexPath(path: string, overrides?: GrammarSettings): Promise<void> {
    const lang = resolveLanguage(path, overrides);
    if (!lang) return;
    let source: string;
    try {
      source = await this.#workspace.read(path);
    } catch {
      this.#store.removeFile(path);
      return;
    }
    const { nodes, edges } = await extractFromSource(
      path,
      source,
      lang,
      overrides,
    );
    this.#store.replaceFile(path, nodes, edges);
  }
}
