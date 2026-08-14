import { expect, test } from "bun:test";
import { NanoHostRegistry } from "./nanoHost";

test("available() reflects registered sockets", () => {
  const registry = new NanoHostRegistry(async () => { throw new Error("unused"); });
  expect(registry.available()).toBe(false);
  registry.register("sock-a");
  expect(registry.available()).toBe(true);
  registry.unregister("sock-a");
  expect(registry.available()).toBe(false);
});

test("chat() targets the most-recently-registered socket", async () => {
  const seen: unknown[] = [];
  const registry = new NanoHostRegistry(async (ws, method, params) => {
    seen.push({ ws, method, params });
    return { done: true };
  });
  registry.register("a");
  registry.register("b");
  for await (const _ of registry.chat([], [], new AbortController().signal)) { /* drain */ }
  expect(seen).toHaveLength(1);
  expect((seen[0] as { ws: string }).ws).toBe("b");
});

test("chat() falls back to the remaining socket after the newest one unregisters", async () => {
  const seen: unknown[] = [];
  const registry = new NanoHostRegistry(async (ws) => { seen.push(ws); return { done: true }; });
  registry.register("a");
  registry.register("b");
  registry.unregister("b");
  for await (const _ of registry.chat([], [], new AbortController().signal)) { /* drain */ }
  expect(seen).toEqual(["a"]);
});

test("chat() throws when no host is registered", async () => {
  const registry = new NanoHostRegistry(async () => ({ done: true }));
  await expect((async () => {
    for await (const _ of registry.chat([], [], new AbortController().signal)) { /* */ }
  })()).rejects.toThrow("no nano host connected");
});

test("chat() surfaces a requestSocket rejection", async () => {
  const registry = new NanoHostRegistry(async () => { throw new Error("socket closed"); });
  registry.register("x");
  await expect((async () => {
    for await (const _ of registry.chat([], [], new AbortController().signal)) { /* */ }
  })()).rejects.toThrow("socket closed");
});

test("chat() yields deltas pushed via handleChatDelta before resolving", async () => {
  let capturedRequestId = "";
  const registry = new NanoHostRegistry(async (_ws, _method, params) => {
    capturedRequestId = (params as { requestId: string }).requestId;
    await new Promise((r) => setTimeout(r, 20));
    return { done: true };
  });
  registry.register("only");

  const results: unknown[] = [];
  const consume = (async () => {
    for await (const d of registry.chat([], [], new AbortController().signal)) results.push(d);
  })();

  await new Promise((r) => setTimeout(r, 5));
  registry.handleChatDelta({ requestId: capturedRequestId, delta: { text: "hi" } });
  registry.handleChatDelta({ requestId: capturedRequestId, delta: { text: " there" } });
  await consume;

  expect(results).toEqual([{ text: "hi" }, { text: " there" }]);
});

test("chat() returns promptly on abort and asks the browser to cancel", async () => {
  const calls: { method: string; params: unknown }[] = [];
  const registry = new NanoHostRegistry(async (_ws, method, params) => {
    calls.push({ method, params });
    // The browser never answers nano/chat: it is mid-generation.
    if (method === "nano/chat") return await new Promise(() => {});
    return {};
  });
  registry.register("only");

  const controller = new AbortController();
  const consume = (async () => {
    for await (const _ of registry.chat([], [], controller.signal)) { /* drain */ }
  })();

  await new Promise((r) => setTimeout(r, 5));
  controller.abort();
  await Promise.race([consume, new Promise((_r, reject) => setTimeout(() => reject(new Error("chat() did not return on abort")), 200))]);

  expect(calls.map((c) => c.method)).toEqual(["nano/chat", "nano/cancel"]);
  const chatId = (calls[0]!.params as { requestId: string }).requestId;
  expect((calls[1]!.params as { requestId: string }).requestId).toBe(chatId);
});

test("handleChatDelta for an unknown requestId is a no-op", () => {
  const registry = new NanoHostRegistry(async () => ({ done: true }));
  expect(() => registry.handleChatDelta({ requestId: "ghost", delta: { text: "x" } })).not.toThrow();
});
