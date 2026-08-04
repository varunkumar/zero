import { z } from "zod";
import { createDaemon, type DaemonOptions } from "./server";
import { Workspace } from "./workspace";

export function startZero(opts: DaemonOptions) {
  const daemon = createDaemon(opts);
  const ws = new Workspace(opts.root);

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

  const unwatch = ws.watch((path) => daemon.broadcast("fs/changed", { path }));
  const stop = daemon.stop;
  return { ...daemon, stop: () => { unwatch(); stop(); } };
}
