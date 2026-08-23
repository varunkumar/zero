import type { TodoEntry } from "@zero/protocol";
import type { Workspace } from "../../workspace";

export type { TodoEntry } from "@zero/protocol";

export interface TodoScannerStatus {
  ready: boolean;
  indexing: boolean;
  fileCount: number;
  lastError?: string;
}

// A bare "#" is a comment starter in Python/shell/YAML, but also shows up
// constantly in TS/JS as `#privateField` syntax, URL fragments, etc. - so
// the set of recognized comment-opening tokens has to be per-language, not
// one blanket list applied to every file (a blanket list matched this very
// file's own `#`-containing regex literal against itself).
const COMMENT_TOKENS_BY_EXT: Record<string, string[]> = {
  ts: ["//", "/*", "*"], tsx: ["//", "/*", "*"], js: ["//", "/*", "*"], jsx: ["//", "/*", "*"],
  mjs: ["//", "/*", "*"], cjs: ["//", "/*", "*"], mts: ["//", "/*", "*"], cts: ["//", "/*", "*"],
  go: ["//", "/*", "*"], rs: ["//", "/*", "*"], java: ["//", "/*", "*"],
  c: ["//", "/*", "*"], h: ["//", "/*", "*"], cpp: ["//", "/*", "*"], hpp: ["//", "/*", "*"],
  swift: ["//", "/*", "*"], kt: ["//", "/*", "*"],
  py: ["#"], rb: ["#"], sh: ["#"], bash: ["#"], zsh: ["#"],
  yml: ["#"], yaml: ["#"], toml: ["#"],
  sql: ["--"], lua: ["--"],
  html: ["<!--"], md: ["<!--"], mdx: ["<!--"], xml: ["<!--"], svg: ["<!--"],
};
// Files with no recognized extension get every token, erring toward
// over-matching rather than silently scanning nothing.
const DEFAULT_COMMENT_TOKENS = ["//", "#", "--", "<!--", "/*", "*"];

const COMMENT_TOKENS_CACHE = new Map<string, string[]>();

function commentTokensFor(path: string): string[] {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
  const cached = COMMENT_TOKENS_CACHE.get(ext);
  if (cached) return cached;
  const tokens = COMMENT_TOKENS_BY_EXT[ext] ?? DEFAULT_COMMENT_TOKENS;
  COMMENT_TOKENS_CACHE.set(ext, tokens);
  return tokens;
}

const MARKER_WORD_RE = /\b(TODO|FIXME|HACK)\b:?\s*(.*)/;

/** Finds a real comment on `line` and, if it contains a marker word,
 * returns it. A comment token found while scanning through a quoted string
 * literal doesn't count - a test fixture that writes a marker-looking
 * comment into a temp file as string data shouldn't turn the line of code
 * doing the writing into a marker itself. Still line-based and quote-aware
 * only, not a real tokenizer - a string spanning multiple lines, or a
 * template interpolation containing a quote, can still confuse it. Real
 * per-language comment detection would need an LSP/tree-sitter, future work. */
function findMarker(line: string, tokens: string[]): { kind: string; text: string } | null {
  // A block-comment continuation line (marker text after a leading "*") is
  // anchored at the line start, so nothing can precede it in a string - no
  // need for the quote-aware scan below.
  if (tokens.includes("*")) {
    const continuation = line.match(/^\s*\*(?!\/)(.*)$/);
    if (continuation) {
      const m = continuation[1].match(MARKER_WORD_RE);
      if (m) return { kind: m[1]!, text: m[2]!.trim() };
    }
  }

  const lineTokens = tokens.filter((t) => t !== "*");
  if (lineTokens.length === 0) return null;

  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    const token = lineTokens.find((t) => line.startsWith(t, i));
    if (token) {
      const m = line.slice(i + token.length).match(MARKER_WORD_RE);
      return m ? { kind: m[1]!, text: m[2]!.trim() } : null;
    }
  }
  return null;
}

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
    const tokens = commentTokensFor(path);
    const out: TodoEntry[] = [];
    content.split("\n").forEach((line, idx) => {
      const m = findMarker(line, tokens);
      if (m) out.push({ path, line: idx + 1, kind: m.kind as TodoEntry["kind"], text: m.text });
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
