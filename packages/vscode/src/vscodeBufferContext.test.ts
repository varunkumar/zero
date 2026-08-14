import { expect, test } from "bun:test";
import { VscodeBufferContext, type DocumentLike } from "./vscodeBufferContext";

test("gathers other open documents as context, excluding the current path", async () => {
  const docs: DocumentLike[] = [
    { path: "a.ts", getText: () => "export const a = 1;" },
    { path: "b.ts", getText: () => "export const b = 2;" },
  ];
  const ctx = new VscodeBufferContext(() => docs);

  const chunks = await ctx.gather({ path: "a.ts", prefix: "", suffix: "" });

  expect(chunks).toHaveLength(1);
  expect(chunks[0].source).toBe("buffer:b.ts");
  expect(chunks[0].text).toBe("export const b = 2;");
});

test("re-reads documents on every gather() call", async () => {
  let docs: DocumentLike[] = [{ path: "a.ts", getText: () => "one" }];
  const ctx = new VscodeBufferContext(() => docs);

  expect(await ctx.gather({ path: "current.ts", prefix: "", suffix: "" })).toHaveLength(1);

  docs = [];
  expect(await ctx.gather({ path: "current.ts", prefix: "", suffix: "" })).toHaveLength(0);
});
