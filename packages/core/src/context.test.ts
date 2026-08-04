import { expect, test } from "bun:test";
import { gatherContext } from "./context";
import { BufferContext } from "./bufferContext";
import type { ContextProvider } from "./types";

const req = { path: "a.ts", prefix: "", suffix: "" };
const chunk = (source: string) => ({ source, text: source, score: 1, tokenCost: 1 });

function provider(name: string, delayMs: number): ContextProvider {
  return { name, gather: () => new Promise((r) => setTimeout(() => r([chunk(name)]), delayMs)) };
}

test("fast providers included, slow dropped, errors swallowed", async () => {
  const boom: ContextProvider = { name: "boom", gather: () => Promise.reject(new Error("x")) };
  const chunks = await gatherContext([provider("fast", 5), provider("slow", 200), boom], req, 50);
  expect(chunks.map((c) => c.source)).toEqual(["fast"]);
});

test("BufferContext excludes the current file and truncates", async () => {
  const buf = new BufferContext();
  buf.setBuffers([
    { path: "a.ts", content: "current" },
    { path: "b.ts", content: "z".repeat(5000) },
  ]);
  const chunks = await buf.gather(req);
  expect(chunks).toHaveLength(1);
  expect(chunks[0]!.source).toBe("buffer:b.ts");
  expect(chunks[0]!.text.length).toBe(2000);
});
