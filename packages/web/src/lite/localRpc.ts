import {
  parseMessage,
  type FsSearchResult,
  type SessionHelloResult,
  type SocketLike,
  type TreeEntry,
} from "@zero/protocol";

export interface LocalRpcOpts {
  workspaceName: string;
  fs: {
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    tree(): Promise<TreeEntry[]>;
    search(query: string, caseSensitive?: boolean): Promise<FsSearchResult>;
    create(path: string, kind: "file" | "dir"): Promise<void>;
    rename(path: string, newPath: string): Promise<void>;
    delete(path: string): Promise<void>;
    move(path: string, newPath: string): Promise<void>;
    copy(path: string, newPath: string): Promise<void>;
  };
  extra?: (method: string, params: unknown) => Promise<unknown>;
}

export class MethodNotAvailable extends Error {
  readonly code = -32601;
  constructor() {
    super("method not available in lite");
    this.name = "MethodNotAvailable";
  }
}

function asRecord(params: unknown): Record<string, unknown> {
  if (params !== null && typeof params === "object" && !Array.isArray(params)) {
    return params as Record<string, unknown>;
  }
  return {};
}

function str(params: unknown, key: string): string {
  const value = asRecord(params)[key];
  if (typeof value !== "string") throw new Error(`invalid params: ${key}`);
  return value;
}

export function createLocalSocket(opts: LocalRpcOpts): SocketLike & {
  notify(method: string, params: unknown): void;
} {
  const socket: SocketLike & { notify(method: string, params: unknown): void } = {
    onmessage: null,
    send(data: string) {
      const msg = parseMessage(data);
      if (!("id" in msg && "method" in msg)) return;
      void settle(msg.id, msg.method, msg.params);
    },
    notify(method, params) {
      post({ jsonrpc: "2.0", method, params });
    },
  };

  function post(payload: unknown): void {
    const raw = JSON.stringify(payload);
    queueMicrotask(() => socket.onmessage?.(raw));
  }

  async function settle(id: number, method: string, params: unknown): Promise<void> {
    try {
      const result = await dispatch(method, params);
      post({ jsonrpc: "2.0", id, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof MethodNotAvailable ? err.code : -32000;
      post({ jsonrpc: "2.0", id, error: { code, message } });
    }
  }

  async function dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "session/hello": {
        const hello: SessionHelloResult = {
          capabilities: { pty: false, lsp: false, graph: false, git: false, models: ["nano"] },
          workspace: { name: opts.workspaceName, kind: "browser-fs" },
        };
        return hello;
      }
      case "fs/read":
        return { content: await opts.fs.read(str(params, "path")) };
      case "fs/write": {
        const path = str(params, "path");
        await opts.fs.write(path, str(params, "content"));
        socket.notify("fs/changed", { path });
        return {};
      }
      case "fs/tree":
        return { entries: await opts.fs.tree() };
      case "fs/search": {
        const query = str(params, "query");
        const rawCase = asRecord(params).caseSensitive;
        const caseSensitive = typeof rawCase === "boolean" ? rawCase : undefined;
        return await opts.fs.search(query, caseSensitive);
      }
      case "fs/create": {
        const path = str(params, "path");
        const kind = asRecord(params).kind;
        if (kind !== "file" && kind !== "dir") throw new Error("invalid params: kind");
        await opts.fs.create(path, kind);
        socket.notify("fs/changed", { path });
        return {};
      }
      case "fs/rename":
      case "fs/move":
      case "fs/copy": {
        const path = str(params, "path");
        const newPath = str(params, "newPath");
        if (method === "fs/rename") await opts.fs.rename(path, newPath);
        else if (method === "fs/move") await opts.fs.move(path, newPath);
        else await opts.fs.copy(path, newPath);
        socket.notify("fs/changed", { path: newPath });
        return {};
      }
      case "fs/delete": {
        const path = str(params, "path");
        await opts.fs.delete(path);
        socket.notify("fs/changed", { path });
        return {};
      }
      case "settings/get":
      case "settings/set":
        return {};
      case "system/whoami":
        return { username: "you" };
      default:
        if (opts.extra) return await opts.extra(method, params);
        throw new MethodNotAvailable();
    }
  }

  return socket;
}
