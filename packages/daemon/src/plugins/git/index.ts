import { z } from "zod";
import type { PluginContext, ZeroPlugin } from "../types";
import { getGitStatus } from "./status";
import { getGitBlame } from "./blame";

/** git-status/blame as an on/off-toggleable built-in, matching Graphify's factory shape. */
export function createGit(): {
  factory: (ctx: PluginContext) => ZeroPlugin;
} {
  const factory = (ctx: PluginContext): ZeroPlugin => {
    let enabled = true;
    let lastError: string | undefined;

    return {
      manifest: {
        id: "git",
        name: "Git",
        version: "0.1.0",
        contributions: { rpcMethods: ["git/status", "git/blame"], ui: true },
      },
      async activate(c) {
        const setting = await c.workspace.readSetting("git.enabled");
        enabled = setting === undefined ? true : Boolean(setting);
        if (!enabled) return;

        c.register("git/status", z.object({}).optional().transform(() => ({})),
          async () => {
            try {
              return { status: await getGitStatus(c.root) };
            } catch (e) {
              lastError = e instanceof Error ? e.message : String(e);
              return { status: null };
            }
          });
        c.register("git/blame", z.object({ path: z.string() }),
          async (p) => {
            try {
              return { blame: await getGitBlame(c.root, p.path) };
            } catch (e) {
              lastError = e instanceof Error ? e.message : String(e);
              return { blame: null };
            }
          });
      },
      health() {
        if (!enabled) return { ok: true, detail: "disabled" };
        return lastError ? { ok: false, detail: lastError } : { ok: true };
      },
      enabled: () => enabled,
    };
  };

  return { factory };
}
