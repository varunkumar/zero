import { expect, test } from "bun:test";
import { GatewayCompletionProvider } from "./gatewayCompletionProvider";

test("capabilities report no FIM support (chat-wrapped completions)", () => {
  const provider = new GatewayCompletionProvider({ baseUrl: "http://127.0.0.1:4821", apiKey: "k" });
  expect(provider.capabilities().supportsFim).toBe(false);
});

test("available() reflects /health's provider field", async () => {
  const provider = new GatewayCompletionProvider({
    baseUrl: "http://127.0.0.1:4821", apiKey: "k",
    fetchImpl: (async (url: string) => {
      expect(url).toBe("http://127.0.0.1:4821/health");
      return new Response(JSON.stringify({ nanoHostConnected: false, provider: "stub" }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  expect(await provider.available()).toBe(true);
});

test("available() is false when no provider is picked", async () => {
  const provider = new GatewayCompletionProvider({
    baseUrl: "http://127.0.0.1:4821", apiKey: "k",
    fetchImpl: (async () => new Response(JSON.stringify({ nanoHostConnected: false, provider: null }), { status: 200 })) as unknown as typeof fetch,
  });
  expect(await provider.available()).toBe(false);
});

test("complete() posts the prompt and yields the response text", async () => {
  const provider = new GatewayCompletionProvider({
    baseUrl: "http://127.0.0.1:4821", apiKey: "secret",
    fetchImpl: (async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:4821/v1/complete");
      expect(init?.headers).toMatchObject({ "x-api-key": "secret" });
      expect(JSON.parse(init?.body as string)).toEqual({ prompt: "const x = " });
      return new Response(JSON.stringify({ text: "1;" }), { status: 200 });
    }) as unknown as typeof fetch,
  });

  const chunks: string[] = [];
  for await (const chunk of provider.complete("const x = ", new AbortController().signal)) {
    chunks.push(chunk);
  }
  expect(chunks).toEqual(["1;"]);
});

test("complete() throws on a non-ok response", async () => {
  const provider = new GatewayCompletionProvider({
    baseUrl: "http://127.0.0.1:4821", apiKey: "k",
    fetchImpl: (async () => new Response("no model available", { status: 503 })) as unknown as typeof fetch,
  });
  await expect(async () => {
    for await (const _ of provider.complete("x", new AbortController().signal)) { /* drain */ }
  }).toThrow();
});

test("complete() calls onError with a message before throwing on a non-ok response", async () => {
  const errors: string[] = [];
  const provider = new GatewayCompletionProvider({
    baseUrl: "http://127.0.0.1:4821", apiKey: "k",
    onError: (msg) => errors.push(msg),
    fetchImpl: (async () => new Response("unauthorized", { status: 401, statusText: "Unauthorized" })) as unknown as typeof fetch,
  });
  await expect(async () => {
    for await (const _ of provider.complete("x", new AbortController().signal)) { /* drain */ }
  }).toThrow();
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("401");
});

test("complete() yields plain text unchanged", async () => {
  const provider = new GatewayCompletionProvider({
    baseUrl: "http://127.0.0.1:4821", apiKey: "k",
    fetchImpl: (async () => new Response(JSON.stringify({ text: "const y = 2;" }), { status: 200 })) as unknown as typeof fetch,
  });
  const chunks: string[] = [];
  for await (const chunk of provider.complete("const x = ", new AbortController().signal)) chunks.push(chunk);
  expect(chunks).toEqual(["const y = 2;"]);
});

test("complete() strips a fenced response with a language tag", async () => {
  const provider = new GatewayCompletionProvider({
    baseUrl: "http://127.0.0.1:4821", apiKey: "k",
    fetchImpl: (async () =>
      new Response(JSON.stringify({ text: "```js\nconst y = 2;\n```" }), { status: 200 })) as unknown as typeof fetch,
  });
  const chunks: string[] = [];
  for await (const chunk of provider.complete("const x = ", new AbortController().signal)) chunks.push(chunk);
  expect(chunks).toEqual(["const y = 2;"]);
});

test("complete() strips a fenced response with no language tag", async () => {
  const provider = new GatewayCompletionProvider({
    baseUrl: "http://127.0.0.1:4821", apiKey: "k",
    fetchImpl: (async () =>
      new Response(JSON.stringify({ text: "```\nconst y = 2;\n```" }), { status: 200 })) as unknown as typeof fetch,
  });
  const chunks: string[] = [];
  for await (const chunk of provider.complete("const x = ", new AbortController().signal)) chunks.push(chunk);
  expect(chunks).toEqual(["const y = 2;"]);
});

test("complete() drops a fenced example-usage block appended after real code", async () => {
  // Reproduces a real response: unfenced completion followed by a fenced
  // "here's how you'd call it" block - the fence must not leak literal
  // backticks into the editor as ghost text.
  const text = [
    "function add(a, b) {",
    "  return a + b;",
    "}",
    "",
    "```javascript",
    "let result = add(5, 7);",
    "console.log(result); // 12",
    "```",
  ].join("\n");
  const provider = new GatewayCompletionProvider({
    baseUrl: "http://127.0.0.1:4821", apiKey: "k",
    fetchImpl: (async () => new Response(JSON.stringify({ text }), { status: 200 })) as unknown as typeof fetch,
  });
  const chunks: string[] = [];
  for await (const chunk of provider.complete("", new AbortController().signal)) chunks.push(chunk);
  expect(chunks).toEqual(["function add(a, b) {\n  return a + b;\n}\n"]);
});
