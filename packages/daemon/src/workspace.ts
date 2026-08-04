import { promises as fs, watch as fsWatch, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { createHash } from "node:crypto";
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

  #fingerprint(abs: string): string | undefined {
    try {
      const stat = statSync(abs);
      if (stat.isDirectory()) return "dir";
      return createHash("sha1").update(readFileSync(abs)).digest("hex");
    } catch {
      return undefined;
    }
  }

  #snapshotFingerprints(): Map<string, string> {
    const snapshot = new Map<string, string>();
    const walk = (dir: string) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = join(dir, entry.name);
        const rel = relative(this.#root, abs);
        const fp = this.#fingerprint(abs);
        if (fp !== undefined) snapshot.set(rel, fp);
        if (entry.isDirectory()) walk(abs);
      }
    };
    walk(this.#root);
    return snapshot;
  }

  watch(onChange: (relPath: string) => void): () => void {
    // Recursive fs.watch on some platforms/runtimes (e.g. Bun on macOS via
    // FSEvents) batches near-simultaneous filesystem changes and reports only
    // one representative filename per batch, which can be a backlogged event
    // for a file that changed just before the watcher was created rather than
    // the change that actually triggered this callback. So the reported
    // filename can't be trusted on its own: instead, treat any event as a
    // "something changed, go check" signal, re-fingerprint the whole tree,
    // and report every path whose content fingerprint actually differs from
    // the last known snapshot (added, changed, or removed).
    let fingerprints = this.#snapshotFingerprints();
    let pending: ReturnType<typeof setTimeout> | undefined;
    const diff = () => {
      pending = undefined;
      const next = this.#snapshotFingerprints();
      const seen = new Set<string>();
      for (const [rel, fp] of next) {
        seen.add(rel);
        if (fingerprints.get(rel) !== fp) onChange(rel);
      }
      for (const rel of fingerprints.keys()) {
        if (!seen.has(rel)) onChange(rel);
      }
      fingerprints = next;
    };
    const watcher = fsWatch(this.#root, { recursive: true }, () => {
      // Debounce briefly: a write can straddle the moment this callback
      // fires, so give in-flight fs operations a beat to land before
      // re-fingerprinting the tree.
      if (pending !== undefined) clearTimeout(pending);
      pending = setTimeout(diff, 50);
    });
    return () => {
      if (pending !== undefined) clearTimeout(pending);
      watcher.close();
    };
  }
}
