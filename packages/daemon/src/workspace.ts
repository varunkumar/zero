import { promises as fs, watch as fsWatch, realpathSync } from "node:fs";
import { join, resolve, relative, sep, dirname, basename } from "node:path";
import ignore, { type Ignore } from "ignore";
import type { TreeEntry } from "@zero/protocol";

export class PathOutsideWorkspaceError extends Error {}

export class Workspace {
  #root: string;
  constructor(root: string) {
    const abs = resolve(root);
    // Resolve the root itself through symlinks too (e.g. macOS tmpdirs are
    // symlinks), so containment checks below compare like-for-like real paths.
    try { this.#root = realpathSync(abs); } catch { this.#root = abs; }
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

  async read(rel: string): Promise<string> {
    return fs.readFile(await this.#resolveReal(rel), "utf8");
  }

  async write(rel: string, content: string): Promise<void> {
    await fs.writeFile(await this.#resolveReal(rel), content, "utf8");
  }

  async #ignorer(): Promise<Ignore> {
    const ig = ignore().add([".git"]);
    try { ig.add(await fs.readFile(join(this.#root, ".gitignore"), "utf8")); } catch {}
    return ig;
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

  watch(onChange: (relPath: string) => void): () => void {
    const watcher = fsWatch(this.#root, { recursive: true }, (_event, filename) => {
      if (filename) onChange(String(filename));
    });
    return () => watcher.close();
  }
}
