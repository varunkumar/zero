import type { TreeEntry } from "@zero/protocol";
import { assertSafePath } from "./paths";

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

  async tree(): Promise<TreeEntry[]> {
    const out: TreeEntry[] = [];
    const walk = async (dir: DirHandle, prefix: string) => {
      for await (const [name, handle] of dir.entries()) {
        if (name === ".git" || name === "node_modules") continue;
        const path = joinRel(prefix, name);
        out.push({ path, kind: handle.kind === "directory" ? "dir" : "file" });
        if (handle.kind === "directory") await walk(handle, path);
      }
    };
    await walk(this.#root, "");
    return out;
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
