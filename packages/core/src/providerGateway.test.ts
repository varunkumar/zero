import { expect, test } from "bun:test";
import { ProviderGateway } from "./providerGateway";
import type { ChatCapableProvider } from "./chatTypes";

function fakeProvider(id: string, avail: boolean, supportsTools: boolean): ChatCapableProvider {
  return {
    id,
    available: async () => avail,
    capabilities: () => ({ id, contextWindowTokens: 100_000, supportsFim: false }),
    supportsTools: () => supportsTools,
    async *complete() {},
    async *chat() {},
  };
}

test("returns null when no providers are available", async () => {
  const gateway = new ProviderGateway([fakeProvider("a", false, true)]);
  expect(await gateway.pick()).toBeNull();
});

test("prefers a tool-supporting provider over an earlier non-tool one", async () => {
  const nonTool = fakeProvider("a", true, false);
  const tool = fakeProvider("b", true, true);
  const gateway = new ProviderGateway([nonTool, tool]);
  expect((await gateway.pick())?.id).toBe("b");
});

test("falls back to the first available provider when none support tools", async () => {
  const gateway = new ProviderGateway([fakeProvider("a", true, false), fakeProvider("b", true, false)]);
  expect((await gateway.pick())?.id).toBe("a");
});

test("replace() swaps the provider list used by later pick() calls", async () => {
  const gateway = new ProviderGateway([fakeProvider("old", true, true)]);
  expect((await gateway.pick())?.id).toBe("old");
  gateway.replace([fakeProvider("new", true, true)]);
  expect((await gateway.pick())?.id).toBe("new");
});

test("a provider whose available() throws is treated as unavailable", async () => {
  const broken: ChatCapableProvider = {
    ...fakeProvider("a", true, true),
    available: async () => { throw new Error("boom"); },
  };
  const gateway = new ProviderGateway([broken, fakeProvider("b", true, true)]);
  expect((await gateway.pick())?.id).toBe("b");
});
