import { z } from "zod";
import type { PluginContext, ZeroPlugin } from "../types";
import { TodoScanner } from "./scanner";

export type { TodoScanner } from "./scanner";

/**
 * Factory holder so main can hook fs/changed onto the live scanner without
 * reaching into plugin internals - mirrors Graphify's createGraphify() shape.
 */
export function createTodoScanner(): {
  factory: (ctx: PluginContext) => ZeroPlugin;
  getScanner: () => TodoScanner | undefined;
} {
  let scanner: TodoScanner | undefined;

  const factory = (ctx: PluginContext): ZeroPlugin => {
    let enabled = true;

    return {
      manifest: {
        id: "todos",
        name: "TODO/FIXME Scanner",
        version: "0.1.0",
        contributions: { rpcMethods: ["todos/list", "todos/at"] },
      },
      async activate(c) {
        const setting = await c.workspace.readSetting("todos.enabled");
        enabled = setting === undefined ? true : Boolean(setting);
        if (!enabled) return;

        scanner = new TodoScanner({ workspace: c.workspace });
        c.register("todos/list", z.object({}).optional().transform(() => ({})),
          async () => ({ entries: scanner!.list() }));
        c.register("todos/at", z.object({ path: z.string() }),
          async (p) => ({ entries: scanner!.at(p.path) }));
        scanner.startFullScan();
      },
      health() {
        if (!enabled) return { ok: true, detail: "disabled" };
        const status = scanner?.status();
        return status?.lastError ? { ok: false, detail: status.lastError } : { ok: true };
      },
    };
  };

  return { factory, getScanner: () => scanner };
}
