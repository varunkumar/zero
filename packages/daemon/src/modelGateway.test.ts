import { expect, test } from "bun:test";
import { ProviderGateway, type ChatCapableProvider } from "@zero/core";
import { startModelGateway } from "./modelGateway";

function stubProvider(reply: string): ChatCapableProvider {
  return {
    id: "stub",
    available: async () => true,
    capabilities: () => ({ id: "stub", contextWindowTokens: 100_000, supportsFim: false }),
    supportsTools: () => true,
    async *complete() {},
    async *chat() { yield { text: reply }; },
  };
}

test("rejects requests without the api key", async () => {
  const gw = startModelGateway({ port: 0, gateway: new ProviderGateway([stubProvider("hi")]) });
  const res = await fetch(`http://127.0.0.1:${gw.port}/v1/messages`, {
    method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  expect(res.status).toBe(401);
  gw.stop();
});

test("streams an SSE response for a valid request with the api key", async () => {
  const gw = startModelGateway({ port: 0, gateway: new ProviderGateway([stubProvider("hello there")]) });
  const res = await fetch(`http://127.0.0.1:${gw.port}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": gw.apiKey, "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain("event: message_start");
  expect(text).toContain("hello there");
  expect(text).toContain("event: message_stop");
  gw.stop();
});

test("returns 503 when no provider is available", async () => {
  const unavailable = { ...stubProvider("x"), available: async () => false };
  const gw = startModelGateway({ port: 0, gateway: new ProviderGateway([unavailable]) });
  const res = await fetch(`http://127.0.0.1:${gw.port}/v1/messages`, {
    method: "POST", headers: { "x-api-key": gw.apiKey }, body: JSON.stringify({ messages: [] }),
  });
  expect(res.status).toBe(503);
  gw.stop();
});
