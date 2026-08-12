import type { DirHandle, FileHandle } from "./browserFs";

function notFound(name: string): Error {
  const err = new Error(`NotFoundError: ${name}`);
  err.name = "NotFoundError";
  return err;
}

function typeMismatch(name: string): Error {
  const err = new Error(`TypeMismatchError: ${name}`);
  err.name = "TypeMismatchError";
  return err;
}

class MemFile implements FileHandle {
  readonly kind = "file" as const;
  content = "";

  constructor(readonly name: string) {}

  async getFile(): Promise<{ text(): Promise<string>; size: number }> {
    return {
      text: async () => this.content,
      size: this.content.length,
    };
  }

  async createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }> {
    this.content = "";
    return {
      write: async (data: string) => {
        this.content += data;
      },
      close: async () => {},
    };
  }
}

export class MemDir implements DirHandle {
  readonly kind = "directory" as const;
  readonly #children = new Map<string, MemDir | MemFile>();

  constructor(readonly name: string) {}

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle> {
    const existing = this.#children.get(name);
    if (existing) {
      if (existing.kind !== "directory") throw typeMismatch(name);
      return existing;
    }
    if (!opts?.create) throw notFound(name);
    const dir = new MemDir(name);
    this.#children.set(name, dir);
    return dir;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle> {
    const existing = this.#children.get(name);
    if (existing) {
      if (existing.kind !== "file") throw typeMismatch(name);
      return existing;
    }
    if (!opts?.create) throw notFound(name);
    const file = new MemFile(name);
    this.#children.set(name, file);
    return file;
  }

  async removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void> {
    const existing = this.#children.get(name);
    if (!existing) throw notFound(name);
    if (existing.kind === "directory" && !opts?.recursive && existing.#children.size > 0) {
      const err = new Error(`InvalidModificationError: ${name}`);
      err.name = "InvalidModificationError";
      throw err;
    }
    this.#children.delete(name);
  }

  async *entries(): AsyncIterableIterator<[string, DirHandle | FileHandle]> {
    for (const [name, handle] of this.#children) yield [name, handle];
  }
}

export function createMemRoot(name: string): DirHandle {
  return new MemDir(name);
}
