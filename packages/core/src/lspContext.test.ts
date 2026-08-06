import { expect, test } from "bun:test";
import { LspContext, type LspContextClient } from "./lspContext";

function fakeClient(response: { chunks: { text: string; score: number }[] }): LspContextClient {
  return { request: async () => response as never };
}

test("gather converts lsp/contextAt chunks into ContextChunks with computed cursor position", async () => {
  let sentParams: unknown;
  const client: LspContextClient = {
    request: async (method, params) => {
      sentParams = params;
      expect(method).toBe("lsp/contextAt");
      return { chunks: [{ text: "const x: number", score: 0.6 }] } as never;
    },
  };
  const ctx = new LspContext(client);
  const chunks = await ctx.gather({ path: "a.ts", prefix: "line one\nconst x ", suffix: "= 1;" });

  expect(sentParams).toEqual({ path: "a.ts", position: { line: 1, character: 8 } });
  expect(chunks).toEqual([{ source: "lsp", text: "const x: number", score: 0.6, tokenCost: 4 }]);
});

test("gather returns no chunks when the daemon has nothing", async () => {
  const ctx = new LspContext(fakeClient({ chunks: [] }));
  expect(await ctx.gather({ path: "a.ts", prefix: "", suffix: "" })).toEqual([]);
});
