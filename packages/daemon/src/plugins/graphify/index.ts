import { z } from "zod";
import type { PluginContext, ZeroPlugin } from "../types";
import { GraphStore } from "./store";
import { GraphIndexer } from "./indexer";
import { queryGraph } from "./query";
import { contextAt } from "./contextAt";
import type { GrammarSettings } from "./grammars";

export type { GraphIndexer } from "./indexer";
export { GraphStore } from "./store";

/**
 * Factory holder so main can hook fs/changed onto the live indexer
 * without reaching into plugin internals.
 */
export function createGraphify(): {
  factory: (ctx: PluginContext) => ZeroPlugin;
  getIndexer: () => GraphIndexer | undefined;
} {
  let indexer: GraphIndexer | undefined;

  const factory = (ctx: PluginContext): ZeroPlugin => {
    const store = new GraphStore();

    const getGrammarSettings = async (): Promise<GrammarSettings | undefined> => {
      const value = await ctx.workspace.readSetting("graphify.grammars");
      if (typeof value !== "object" || value === null) return undefined;
      return value as GrammarSettings;
    };

    indexer = new GraphIndexer({
      workspace: ctx.workspace,
      store,
      getGrammarSettings,
    });

    return {
      manifest: {
        id: "graphify",
        name: "Graphify",
        version: "0.1.0",
        contributions: {
          rpcMethods: ["graph/contextAt", "graph/query", "graph/status"],
          contextProviders: ["graph"],
          tools: ["graph_query"],
        },
      },
      async activate(c) {
        c.register(
          "graph/status",
          z.object({}).optional().transform(() => ({})),
          async () => indexer!.status(),
        );
        c.register(
          "graph/contextAt",
          z.object({
            path: z.string(),
            position: z.object({ line: z.number(), character: z.number() }),
            maxChunks: z.number().optional(),
          }),
          async (p) => {
            const st = indexer!.status();
            const chunks = st.nodeCount > 0 ? contextAt(store, p) : [];
            return { chunks, ready: st.ready || st.nodeCount > 0 };
          },
        );
        c.register(
          "graph/query",
          z.object({
            q: z.string(),
            mode: z.enum(["neighbors", "symbol", "path"]).optional(),
            budgetTokens: z.number().optional(),
          }),
          async (p) => queryGraph(store, p),
        );
        await indexer!.loadCacheIfPresent();
        indexer!.startFullIndex();
      },
      health() {
        const s = indexer!.status();
        return { ok: !s.lastError || s.ready, detail: s.lastError };
      },
    };
  };

  return { factory, getIndexer: () => indexer };
}

/** @deprecated Prefer createGraphify().factory for main wiring. */
export function createGraphifyPlugin(ctx: PluginContext): ZeroPlugin {
  return createGraphify().factory(ctx);
}
