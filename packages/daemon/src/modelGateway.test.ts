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

test("returns 400 for an invalid request body", async () => {
  const gw = startModelGateway({ port: 0, gateway: new ProviderGateway([stubProvider("hi")]) });
  const resInvalidJson = await fetch(`http://127.0.0.1:${gw.port}/v1/messages`, {
    method: "POST", headers: { "x-api-key": gw.apiKey }, body: "not json",
  });
  expect(resInvalidJson.status).toBe(400);

  const resMissingMessages = await fetch(`http://127.0.0.1:${gw.port}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": gw.apiKey, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(resMissingMessages.status).toBe(400);
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

test("rejects /v1/complete requests without the api key", async () => {
  const gw = startModelGateway({ port: 0, gateway: new ProviderGateway([stubProvider("hi")]) });
  const res = await fetch(`http://127.0.0.1:${gw.port}/v1/complete`, {
    method: "POST", body: JSON.stringify({ prompt: "const x = " }),
  });
  expect(res.status).toBe(401);
  gw.stop();
});

test("returns completion text for a valid /v1/complete request", async () => {
  const gw = startModelGateway({ port: 0, gateway: new ProviderGateway([stubProvider("1;")]) });
  const res = await fetch(`http://127.0.0.1:${gw.port}/v1/complete`, {
    method: "POST",
    headers: { "x-api-key": gw.apiKey, "content-type": "application/json" },
    body: JSON.stringify({ prompt: "const x = " }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ text: "1;" });
  gw.stop();
});

test("returns 400 for an invalid /v1/complete request body", async () => {
  const gw = startModelGateway({ port: 0, gateway: new ProviderGateway([stubProvider("hi")]) });
  const resBadJson = await fetch(`http://127.0.0.1:${gw.port}/v1/complete`, {
    method: "POST", headers: { "x-api-key": gw.apiKey }, body: "not json",
  });
  expect(resBadJson.status).toBe(400);

  const resMissingPrompt = await fetch(`http://127.0.0.1:${gw.port}/v1/complete`, {
    method: "POST",
    headers: { "x-api-key": gw.apiKey, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(resMissingPrompt.status).toBe(400);
  gw.stop();
});

test("returns 503 from /v1/complete when no provider is available", async () => {
  const unavailable = { ...stubProvider("x"), available: async () => false };
  const gw = startModelGateway({ port: 0, gateway: new ProviderGateway([unavailable]) });
  const res = await fetch(`http://127.0.0.1:${gw.port}/v1/complete`, {
    method: "POST", headers: { "x-api-key": gw.apiKey, "content-type": "application/json" },
    body: JSON.stringify({ prompt: "x" }),
  });
  expect(res.status).toBe(503);
  gw.stop();
});

test("GET /health reports the picked provider", async () => {
  const gw = startModelGateway({ port: 0, gateway: new ProviderGateway([stubProvider("hi")]) });
  const res = await fetch(`http://127.0.0.1:${gw.port}/health`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ nanoHostConnected: false, provider: "stub" });
  gw.stop();
});

test("GET /health reports no provider when none is available", async () => {
  const unavailable = { ...stubProvider("x"), available: async () => false };
  const gw = startModelGateway({ port: 0, gateway: new ProviderGateway([unavailable]) });
  const res = await fetch(`http://127.0.0.1:${gw.port}/health`);
  expect(await res.json()).toEqual({ nanoHostConnected: false, provider: null });
  gw.stop();
});

test("GET /health reports nanoHostConnected when the nano bridge is picked", async () => {
  const nano = { ...stubProvider("x"), id: "nano-bridge" };
  const gw = startModelGateway({ port: 0, gateway: new ProviderGateway([nano]) });
  const res = await fetch(`http://127.0.0.1:${gw.port}/health`);
  expect(await res.json()).toEqual({ nanoHostConnected: true, provider: "nano-bridge" });
  gw.stop();
});
