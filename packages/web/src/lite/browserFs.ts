import ignore, { type Ignore } from "ignore";
import type { FsSearchResult, TreeEntry } from "@zero/protocol";
import { assertSafePath } from "./paths";

const SKIP_NAMES = new Set([".git", "node_modules"]);
const MAX_SEARCH_MATCHES = 200;
const MAX_SEARCH_FILE_BYTES = 1_048_576;
const SEARCH_TIME_MS = 2000;
const BINARY_SNIFF = 8192;

export interface FileHandle {
  name: string;
  kind: "file";
  getFile(): Promise<{ text(): Promise<string>; size: number }>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}

export interface DirHandle {
  name: string;
  kind: "directory";
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterableIterator<[string, DirHandle | FileHandle]>;
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && err.name === "NotFoundError";
}

function joinRel(prefix: string, name: string): string {
  return prefix ? `${prefix}/${name}` : name;
}

function sameRelPath(a: string, b: string): boolean {
  const left = assertSafePath(a);
  const right = assertSafePath(b);
  return left.length === right.length && left.every((seg, i) => seg === right[i]);
}

export class BrowserFSWorkspace {
  #root: DirHandle;

  constructor(root: DirHandle) {
    this.#root = root;
  }

  async #dir(segments: string[], create: boolean): Promise<DirHandle> {
    let cur = this.#root;
    for (const seg of segments) {
      cur = await cur.getDirectoryHandle(seg, create ? { create: true } : undefined);
    }
    return cur;
  }

  async #parentAndName(path: string, createParents: boolean): Promise<{ parent: DirHandle; name: string }> {
    const parts = assertSafePath(path);
    if (parts.length === 0) throw new Error(`path escapes workspace: ${path}`);
    const name = parts[parts.length - 1]!;
    const parent = await this.#dir(parts.slice(0, -1), createParents);
    return { parent, name };
  }

  async read(path: string): Promise<string> {
    const { parent, name } = await this.#parentAndName(path, false);
    const file = await parent.getFileHandle(name);
    return (await file.getFile()).text();
  }

  async write(path: string, content: string): Promise<void> {
    const { parent, name } = await this.#parentAndName(path, true);
    const file = await parent.getFileHandle(name, { create: true });
    const w = await file.createWritable();
    await w.write(content);
    await w.close();
  }

  async #loadIgnores(dirPath: string[]): Promise<Ignore> {
    const ig = ignore();
    try {
      const dir = await this.#dir(dirPath, false);
      const file = await dir.getFileHandle(".gitignore");
      ig.add(await (await file.getFile()).text());
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    return ig;
  }

  #ignored(ancestors: { ig: Ignore; prefix: string }[], path: string, isDir: boolean): boolean {
    for (const { ig, prefix } of ancestors) {
      const rel = prefix ? path.slice(prefix.length + 1) : path;
      if (ig.ignores(isDir ? `${rel}/` : rel)) return true;
    }
    return false;
  }

  async tree(): Promise<TreeEntry[]> {
    const out: TreeEntry[] = [];
    const walk = async (dir: DirHandle, prefix: string, ancestors: { ig: Ignore; prefix: string }[]) => {
      const dirPath = prefix ? prefix.split("/") : [];
      const next = [...ancestors, { ig: await this.#loadIgnores(dirPath), prefix }];
      for await (const [name, handle] of dir.entries()) {
        if (SKIP_NAMES.has(name)) continue;
        const path = joinRel(prefix, name);
        const isDir = handle.kind === "directory";
        if (this.#ignored(next, path, isDir)) continue;
        out.push({ path, kind: isDir ? "dir" : "file" });
        if (isDir) await walk(handle, path, next);
      }
    };
    await walk(this.#root, "", []);
    return out;
  }

  async search(query: string, caseSensitive = false): Promise<FsSearchResult> {
    const started = Date.now();
    const entries = await this.tree();
    const matches: FsSearchResult["matches"] = [];
    const needle = caseSensitive ? query : query.toLowerCase();
    let truncated = false;

    for (const entry of entries) {
      if (Date.now() - started >= SEARCH_TIME_MS) {
        truncated = true;
        break;
      }
      if (entry.kind !== "file") continue;

      const { parent, name } = await this.#parentAndName(entry.path, false);
      let file: FileHandle;
      try {
        file = await parent.getFileHandle(name);
      } catch {
        continue;
      }
      const blob = await file.getFile();
      if (blob.size > MAX_SEARCH_FILE_BYTES) continue;
      const text = await blob.text();
      if (text.slice(0, BINARY_SNIFF).includes("\0")) continue;

      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (Date.now() - started >= SEARCH_TIME_MS) {
          truncated = true;
          break;
        }
        const line = lines[i]!;
        const haystack = caseSensitive ? line : line.toLowerCase();
        const column = haystack.indexOf(needle);
        if (column === -1) continue;
        matches.push({ path: entry.path, line: i + 1, column: column + 1, text: line });
        if (matches.length >= MAX_SEARCH_MATCHES) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }

    return { matches, truncated };
  }

  async #existsIn(parent: DirHandle, name: string): Promise<boolean> {
    try {
      await parent.getFileHandle(name);
      return true;
    } catch (err) {
      if (isNotFound(err)) {
        try {
          await parent.getDirectoryHandle(name);
          return true;
        } catch (dirErr) {
          if (isNotFound(dirErr)) return false;
          throw dirErr;
        }
      }
      try {
        await parent.getDirectoryHandle(name);
        return true;
      } catch (dirErr) {
        if (isNotFound(dirErr)) throw err;
        throw dirErr;
      }
    }
  }

  async create(path: string, kind: "file" | "dir"): Promise<void> {
    const { parent, name } = await this.#parentAndName(path, true);
    try {
      if (kind === "file") await parent.getFileHandle(name);
      else await parent.getDirectoryHandle(name);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      if (kind === "file") {
        const file = await parent.getFileHandle(name, { create: true });
        const w = await file.createWritable();
        await w.write("");
        await w.close();
      } else {
        await parent.getDirectoryHandle(name, { create: true });
      }
      return;
    }
    throw new Error("already exists");
  }

  async rename(path: string, newPath: string): Promise<void> {
    if (sameRelPath(path, newPath)) return;
    await this.copy(path, newPath);
    await this.delete(path);
  }

  async delete(path: string): Promise<void> {
    const { parent, name } = await this.#parentAndName(path, false);
    await parent.removeEntry(name, { recursive: true });
  }

  async move(path: string, newPath: string): Promise<void> {
    return this.rename(path, newPath);
  }

  async copy(path: string, newPath: string): Promise<void> {
    const src = await this.#parentAndName(path, false);
    let file: FileHandle | undefined;
    try {
      file = await src.parent.getFileHandle(src.name);
    } catch (err) {
      if (isNotFound(err)) throw err;
    }

    const dest = await this.#parentAndName(newPath, true);
    if (await this.#existsIn(dest.parent, dest.name)) throw new Error("already exists");

    if (file) {
      const content = await (await file.getFile()).text();
      await this.write(newPath, content);
      return;
    }

    const dir = await src.parent.getDirectoryHandle(src.name);
    await this.create(newPath, "dir");
    for await (const [child] of dir.entries()) {
      await this.copy(joinRel(path, child), joinRel(newPath, child));
    }
  }
}
