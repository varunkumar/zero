import { expect, test } from "bun:test";
import { GraphContext, type GraphContextClient } from "./graphContext";

test("gather maps graph/contextAt chunks and derives cursor from prefix", async () => {
  let sent: unknown;
  const client: GraphContextClient = {
    request: async <R>(method: string, params?: unknown): Promise<R> => {
      sent = { method, params };
      return { ready: true, chunks: [{ text: "function greet", score: 0.9, source: "graph:g" }] } as R;
    },
  };
  const ctx = new GraphContext(client);
  const chunks = await ctx.gather({ path: "a.ts", prefix: "line\ngre", suffix: "et" });
  expect(sent).toEqual({
    method: "graph/contextAt",
    params: { path: "a.ts", position: { line: 1, character: 3 }, maxChunks: 6 },
  });
  expect(chunks[0]).toEqual({
    source: "graph:g", text: "function greet", score: 0.9, tokenCost: Math.ceil("function greet".length / 4),
  });
});

test("gather returns [] when not ready", async () => {
  const client: GraphContextClient = {
    request: async <R>(): Promise<R> =>
      ({ ready: false, chunks: [{ text: "x", score: 1 }] }) as R,
  };
  const ctx = new GraphContext(client);
  expect(await ctx.gather({ path: "a.ts", prefix: "", suffix: "" })).toEqual([]);
});

test("gather returns [] on request error", async () => {
  const client: GraphContextClient = {
    request: async <R>(): Promise<R> => { throw new Error("down"); },
  };
  const ctx = new GraphContext(client);
  expect(await ctx.gather({ path: "a.ts", prefix: "", suffix: "" })).toEqual([]);
});
