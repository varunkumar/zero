import { z } from "zod";
import { createDaemon, type DaemonOptions } from "./server";
import { Workspace } from "./workspace";
import { PtyService } from "./pty";
import { LspService } from "./lsp/service";
import { DEFAULT_LSP_SERVERS, type LspServerConfig } from "./lsp/registry";
import { PluginHost } from "./plugins/host";
import { createGraphify } from "./plugins/graphify";

export async function startZero(opts: DaemonOptions) {
  const daemon = createDaemon(opts);
  const ws = new Workspace(opts.root);
  const pty = new PtyService(
    opts.root,
    (sessionId, data) => daemon.broadcast("pty/output", { sessionId, data }),
    (sessionId, exitCode) => daemon.broadcast("pty/exit", { sessionId, exitCode }),
  );

  const userServers = (await ws.readSetting("lsp.servers")) as Record<string, LspServerConfig> | undefined;
  const servers = { ...DEFAULT_LSP_SERVERS, ...(userServers ?? {}) };
  const lsp = new LspService(ws, servers,
    (path, diagnostics) => daemon.broadcast("lsp/diagnostics", { path, diagnostics }));

  daemon.rpc.register("fs/read", z.object({ path: z.string() }),
    async (p) => ({ content: await ws.read(p.path) }));
  daemon.rpc.register("fs/write", z.object({ path: z.string(), content: z.string() }),
    async (p) => { await ws.write(p.path, p.content); return {}; });
  daemon.rpc.register("fs/tree", z.object({}).optional().transform(() => ({})),
    async () => ({ entries: await ws.tree() }));
  daemon.rpc.register("fs/search", z.object({ query: z.string(), caseSensitive: z.boolean().optional() }),
    async (p) => ws.search(p.query, p.caseSensitive));
  daemon.rpc.register("settings/get", z.object({ key: z.string() }),
    async (p) => ({ value: await ws.readSetting(p.key) }));
  daemon.rpc.register("settings/set", z.object({ key: z.string(), value: z.unknown() }),
    async (p) => { await ws.writeSetting(p.key, p.value); return {}; });

  daemon.rpc.register("pty/open", z.object({ shell: z.string().optional(), cols: z.number(), rows: z.number() }),
    async (p) => pty.open(p.shell, p.cols, p.rows));
  daemon.rpc.register("pty/input", z.object({ sessionId: z.string(), data: z.string() }),
    async (p) => { pty.input(p.sessionId, p.data); return {}; });
  daemon.rpc.register("pty/resize", z.object({ sessionId: z.string(), cols: z.number(), rows: z.number() }),
    async (p) => { pty.resize(p.sessionId, p.cols, p.rows); return {}; });
  daemon.rpc.register("pty/close", z.object({ sessionId: z.string() }),
    async (p) => { pty.close(p.sessionId); return {}; });
  daemon.rpc.register("pty/list", z.object({}).optional().transform(() => ({})),
    async () => ({ sessions: pty.list() }));

  const lspPosition = z.object({ line: z.number(), character: z.number() });
  daemon.rpc.register("lsp/sync", z.object({ path: z.string(), content: z.string() }),
    async (p) => { await lsp.sync(p.path, p.content); return { failed: await lsp.isFailed(p.path) }; });
  daemon.rpc.register("lsp/hover", z.object({ path: z.string(), position: lspPosition }),
    async (p) => ({ contents: await lsp.hover(p.path, p.position) }));
  daemon.rpc.register("lsp/definition", z.object({ path: z.string(), position: lspPosition }),
    async (p) => ({ locations: await lsp.definition(p.path, p.position) }));
  daemon.rpc.register("lsp/contextAt", z.object({ path: z.string(), position: lspPosition }),
    async (p) => ({ chunks: await lsp.contextAt(p.path, p.position) }));

  const graphify = createGraphify();
  const host = new PluginHost({
    rpc: daemon.rpc,
    workspace: ws,
    root: opts.root,
    broadcast: (m, p) => daemon.broadcast(m, p),
  });
  host.registerHostRpcs();
  // Fire-and-forget activation; tests can await pluginsReady.
  // Failures degrade Graphify only (host catches factory/activate errors).
  const pluginsReady = host.activateBuiltins([graphify.factory]);

  const unwatch = ws.watch((path) => {
    daemon.broadcast("fs/changed", { path });
    try {
      graphify.getIndexer()?.onFileChanged(path);
    } catch {
      // Graphify reindex must not break fs broadcast
    }
  });

  const stop = daemon.stop;
  return {
    ...daemon,
    pluginsReady,
    stop: () => {
      unwatch();
      pty.closeAll();
      lsp.dispose();
      stop();
    },
  };
}
