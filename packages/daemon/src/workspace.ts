import { promises as fs, watch as fsWatch } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import type { TreeEntry } from "@zero/protocol";

export class PathOutsideWorkspaceError extends Error {}

export class Workspace {
  #root: string;
  constructor(root: string) { this.#root = resolve(root); }

  #resolve(rel: string): string {
    const abs = resolve(this.#root, rel);
    if (abs !== this.#root && !abs.startsWith(this.#root + sep))
      throw new PathOutsideWorkspaceError(rel);
    return abs;
  }

  async read(rel: string): Promise<string> {
    return fs.readFile(this.#resolve(rel), "utf8");
  }

  async write(rel: string, content: string): Promise<void> {
    await fs.writeFile(this.#resolve(rel), content, "utf8");
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
