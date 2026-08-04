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

  const unwatch = ws.watch((path) => daemon.broadcast("fs/changed", { path }));
  const stop = daemon.stop;
  return { ...daemon, stop: () => { unwatch(); stop(); } };
}
