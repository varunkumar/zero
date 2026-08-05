import { z } from "zod";
import { createDaemon, type DaemonOptions } from "./server";
import { Workspace } from "./workspace";
import { PtyService } from "./pty";

export function startZero(opts: DaemonOptions) {
  const daemon = createDaemon(opts);
  const ws = new Workspace(opts.root);
  const pty = new PtyService(
    opts.root,
    (sessionId, data) => daemon.broadcast("pty/output", { sessionId, data }),
    (sessionId, exitCode) => daemon.broadcast("pty/exit", { sessionId, exitCode }),
  );

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

  const unwatch = ws.watch((path) => daemon.broadcast("fs/changed", { path }));
  const stop = daemon.stop;
  return { ...daemon, stop: () => { unwatch(); pty.closeAll(); stop(); } };
}
