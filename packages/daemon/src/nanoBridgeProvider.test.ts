import { expect, test } from "bun:test";
import { NanoBridgeProvider } from "./nanoBridgeProvider";
import { NanoHostRegistry } from "./nanoHost";

test("available() mirrors the registry", async () => {
  const registry = new NanoHostRegistry(async () => ({ done: true }));
  const provider = new NanoBridgeProvider(registry);
  expect(await provider.available()).toBe(false);
  registry.register("x");
  expect(await provider.available()).toBe(true);
});

test("supportsTools() is true", () => {
  const registry = new NanoHostRegistry(async () => ({ done: true }));
  expect(new NanoBridgeProvider(registry).supportsTools()).toBe(true);
});

test("id is nano-bridge and capabilities report a small context window", () => {
  const registry = new NanoHostRegistry(async () => ({ done: true }));
  const provider = new NanoBridgeProvider(registry);
  expect(provider.id).toBe("nano-bridge");
  expect(provider.capabilities()).toEqual({ id: "nano-bridge", supportsFim: false, contextWindowTokens: 6144 });
});

test("chat() delegates to the registry", async () => {
  const registry = new NanoHostRegistry(async () => ({ done: true }));
  registry.register("x");
  const provider = new NanoBridgeProvider(registry);
  const results: unknown[] = [];
  for await (const d of provider.chat([], [], new AbortController().signal)) results.push(d);
  expect(results).toEqual([]);
});
