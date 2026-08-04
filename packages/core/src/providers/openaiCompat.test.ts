import { expect, test } from "bun:test";
import { OpenAICompatProvider } from "./openaiCompat";

function sseResponse(lines: string[]): Response {
  const body = new ReadableStream({
    start(c) { for (const l of lines) c.enqueue(new TextEncoder().encode(l + "\n\n")); c.close(); },
  });
  return new Response(body, { status: 200 });
}

test("streams SSE chunks", async () => {
  const provider = new OpenAICompatProvider({
    baseUrl: "http://x/v1", model: "qwen",
    fetchImpl: async () => sseResponse([
      'data: {"choices":[{"text":"hel"}]}',
      'data: {"choices":[{"text":"lo"}]}',
      "data: [DONE]",
    ]),
  });
  let out = "";
  for await (const t of provider.complete("p", new AbortController().signal)) out += t;
  expect(out).toBe("hello");
});

test("available() false when endpoint down", async () => {
  const provider = new OpenAICompatProvider({
    baseUrl: "http://x/v1", model: "qwen",
    fetchImpl: async () => { throw new Error("refused"); },
  });
  expect(await provider.available()).toBe(false);
});
