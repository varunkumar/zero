import { promises as fs, watch as fsWatch, realpathSync } from "node:fs";
import { join, resolve, relative, sep, dirname, basename } from "node:path";
import ignore, { type Ignore } from "ignore";
import type { TreeEntry, FsSearchResult } from "@zero/protocol";
import { settingsPath } from "./paths";

export class PathOutsideWorkspaceError extends Error {}

export class Workspace {
  #root: string;
  constructor(root: string) {
    const abs = resolve(root);
    // Resolve the root itself through symlinks too (e.g. macOS tmpdirs are
    // symlinks), so containment checks below compare like-for-like real paths.
    try { this.#root = realpathSync(abs); } catch { this.#root = abs; }
  }

  /** The workspace root, already resolved through symlinks (see
   * constructor). Other daemon subsystems that need to reason about the
   * same filesystem paths Workspace does (e.g. LspService matching
   * language-server-reported `file://` URIs) should reuse this rather than
   * re-deriving or re-realpath'ing opts.root themselves. */
  get root(): string {
    return this.#root;
  }

  #resolve(rel: string): string {
    const abs = resolve(this.#root, rel);
    if (abs !== this.#root && !abs.startsWith(this.#root + sep))
      throw new PathOutsideWorkspaceError(rel);
    return abs;
  }

  // Lexical containment (#resolve) isn't enough: a symlink inside the
  // workspace can point anywhere on disk while still looking "contained"
  // textually. Resolve symlinks and re-verify containment against the real
  // target before touching the filesystem.
  async #resolveReal(rel: string): Promise<string> {
    const abs = this.#resolve(rel); // existing lexical check first
    let real: string;
    try {
      real = await fs.realpath(abs);
    } catch {
      // Path doesn't exist yet (e.g. a new file being written) — resolve its
      // parent directory instead, since the target itself can't be a symlink
      // if it doesn't exist.
      real = join(await fs.realpath(dirname(abs)), basename(abs));
    }
    if (real !== this.#root && !real.startsWith(this.#root + sep))
      throw new PathOutsideWorkspaceError(rel);
    return abs; // original (non-realpath'd) path, now proven safe to use
  }

  /** Public entry point for other subsystems (e.g. LspService) that need
   * this same lexical-plus-symlink containment guard before touching a
   * caller-supplied relative path, without duplicating it. Resolves to the
   * guarded absolute path, or rejects with PathOutsideWorkspaceError. */
  async resolveInRoot(rel: string): Promise<string> {
    return this.#resolveReal(rel);
  }

  async read(rel: string): Promise<string> {
    return fs.readFile(await this.#resolveReal(rel), "utf8");
  }

  async readBinary(rel: string): Promise<Buffer> {
    return fs.readFile(await this.#resolveReal(rel));
  }

  async write(rel: string, content: string): Promise<void> {
    // Create parent dirs first so #resolveReal can realpath them (e.g. `.zero/`).
    const abs = this.#resolve(rel);
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(await this.#resolveReal(rel), content, "utf8");
  }

  // Like #resolveReal, but safe to use when the target doesn't exist yet and
  // intermediate directories may need to be created: `mkdir(dirname(abs),
  // { recursive: true })` followed by a single #resolveReal call (the
  // earlier, still-buggy version of create()) creates every missing
  // ancestor directory *before* containment is ever checked, so if an
  // ancestor turns out to be a symlink pointing outside the root, the OS
  // has already followed it and created directories on the far side by the
  // time #resolveReal throws. Instead, walk the path one segment at a time
  // from the (already-verified) root: realpath and re-verify containment
  // for each segment that exists *before* creating the next one, and only
  // create a segment (as a plain, non-symlink directory) once its parent is
  // proven contained. The final segment is left for the caller to create
  // (`mkdir` for a dir, `writeFile(..., { flag: "wx" })` for a file) so
  // existing-target semantics (EEXIST, ENOTDIR, ...) are preserved exactly.
  async #resolveContainedForCreate(rel: string): Promise<string> {
    const abs = this.#resolve(rel); // lexical check first
    const segments = relative(this.#root, abs).split(sep).filter(Boolean);
    let cur = this.#root;
    for (let i = 0; i < segments.length; i++) {
      const next = join(cur, segments[i]);
      let real: string;
      try {
        real = await fs.realpath(next);
      } catch {
        if (i === segments.length - 1) return next; // final segment: nothing to resolve yet
        await fs.mkdir(next); // cur is proven contained; segments[i] is a literal, just-created name
        real = next;
      }
      if (real !== this.#root && !real.startsWith(this.#root + sep))
        throw new PathOutsideWorkspaceError(rel);
      cur = real;
    }
    return cur; // every segment existed already and was verified contained
  }

  async create(rel: string, kind: "file" | "dir"): Promise<void> {
    const target = await this.#resolveContainedForCreate(rel);
    if (kind === "dir") {
      await fs.mkdir(target, { recursive: true });
    } else {
      await fs.writeFile(target, "", { flag: "wx" });
    }
  }

  async rename(rel: string, newRel: string): Promise<void> {
    const from = await this.#resolveReal(rel);
    const to = await this.#resolveContainedForCreate(newRel);
    await fs.rename(from, to);
  }

  async delete(rel: string): Promise<void> {
    const abs = await this.#resolveReal(rel);
    await fs.rm(abs, { recursive: true, force: false });
  }

  async move(rel: string, newRel: string): Promise<void> {
    return this.rename(rel, newRel);
  }

  async copy(rel: string, newRel: string): Promise<void> {
    const from = await this.#resolveReal(rel);
    const to = await this.#resolveContainedForCreate(newRel);
    await fs.cp(from, to, { recursive: true, errorOnExist: true });
  }

  async #ignorer(): Promise<Ignore> {
    const ig = ignore().add([".git", ".zero"]);
    try { ig.add(await fs.readFile(join(this.#root, ".gitignore"), "utf8")); } catch {}
    return ig;
  }

  async #readSettingsFile(): Promise<Record<string, unknown>> {
    try {
      const raw = await fs.readFile(settingsPath(), "utf8");
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  async readSetting(key: string): Promise<unknown> {
    return (await this.#readSettingsFile())[key];
  }

  async writeSetting(key: string, value: unknown): Promise<void> {
    const all = await this.#readSettingsFile();
    all[key] = value;
    await fs.mkdir(dirname(settingsPath()), { recursive: true });
    await fs.writeFile(settingsPath(), JSON.stringify(all, null, 2), "utf8");
  }

  async tree(): Promise<TreeEntry[]> {
    const ig = await this.#ignorer();
    const out: TreeEntry[] = [];
    const walk = async (dir: string) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        // Symlinks are skipped entirely: Dirent.isDirectory() reports false
        // for a symlinked directory (misclassifying it as a file), and
        // walking through one risks escaping the workspace root or looping.
        // read()/write() independently guard against symlink escapes too.
        if (entry.isSymbolicLink()) continue;
        const rel = relative(this.#root, join(dir, entry.name));
        if (ig.ignores(entry.isDirectory() ? rel + "/" : rel)) continue;
        out.push({ path: rel, kind: entry.isDirectory() ? "dir" : "file" });
        if (entry.isDirectory()) await walk(join(dir, entry.name));
      }
    };
    await walk(this.#root);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async search(query: string, caseSensitive = false): Promise<FsSearchResult> {
    const MAX_MATCHES = 500;
    const MAX_FILE_BYTES = 1_000_000;
    const entries = await this.tree();
    const matches: FsSearchResult["matches"] = [];
    const needle = caseSensitive ? query : query.toLowerCase();
    let truncated = false;

    for (const entry of entries) {
      if (truncated) break;
      if (entry.kind !== "file") continue;
      const abs = join(this.#root, entry.path);
      let stat;
      try { stat = await fs.stat(abs); } catch { continue; }
      if (stat.size > MAX_FILE_BYTES) continue;

      let buf: Buffer;
      try { buf = await fs.readFile(abs); } catch { continue; }
      if (buf.subarray(0, 8000).includes(0)) continue; // binary sniff

      const text = buf.toString("utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const haystack = caseSensitive ? line : line.toLowerCase();
        const column = haystack.indexOf(needle);
        if (column === -1) continue;
        matches.push({ path: entry.path, line: i + 1, column, text: line });
        if (matches.length >= MAX_MATCHES) { truncated = true; break; }
      }
    }

    return { matches, truncated };
  }

  watch(onChange: (relPath: string) => void): () => void {
    const watcher = fsWatch(this.#root, { recursive: true }, (_event, filename) => {
      if (filename) onChange(String(filename));
    });
    return () => watcher.close();
  }
}
