import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcClient, type SocketLike } from "@zero/protocol";
import type { ChatDelta } from "@zero/core";
import { startZero } from "./main";
import { settingsPath } from "./paths";
import { useTempZeroHome } from "./testSupport/zeroHome";

useTempZeroHome();

function wsAdapter(ws: WebSocket): SocketLike {
  const s: SocketLike = { send: (d) => ws.send(d), onmessage: null };
  ws.onmessage = (e) => s.onmessage?.(String(e.data));
  return s;
}

async function openClient(port: number, token: string) {
  const ws = await new Promise<WebSocket>((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}/rpc?token=${token}`);
    w.onopen = () => res(w); w.onerror = rej;
  });
  return { ws, client: new RpcClient(wsAdapter(ws)) };
}

test("a browser answering nano/chat serves a full /v1/messages round trip through the gateway", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  const d = await startZero({ root, gatewayPort: 0 });
  const { ws, client } = await openClient(d.port, d.token);

  client.onRequest("nano/chat", async (params) => {
    const { requestId } = params as { requestId: string };
    client.notify("nano/chatDelta", { requestId, delta: { text: "Hello" } satisfies ChatDelta });
    client.notify("nano/chatDelta", { requestId, delta: { text: " world" } satisfies ChatDelta });
    return { done: true };
  });
  await client.request("nano/register");

  const res = await fetch(`http://127.0.0.1:${d.gatewayInfo!.port}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": d.gatewayInfo!.apiKey, "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain("event: message_start");
  // Each nano/chatDelta notification streams through as its own
  // content_block_delta event (see anthropicTranslate.test.ts), so the two
  // notifications above surface as two separate text_delta chunks rather
  // than a single contiguous "Hello world" substring.
  expect(text).toContain('"text":"Hello"');
  expect(text).toContain('"text":" world"');
  expect(text).toContain('"stop_reason":"end_turn"');
  expect(text).toContain("event: message_stop");

  ws.close(); d.stop();
});

test("a tool_use turn round-trips through the gateway as tool_use content blocks", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  const d = await startZero({ root, gatewayPort: 0 });
  const { ws, client } = await openClient(d.port, d.token);

  client.onRequest("nano/chat", async (params) => {
    const { requestId } = params as { requestId: string };
    client.notify("nano/chatDelta", {
      requestId,
      delta: { toolCalls: [{ id: "call_1", name: "fs_read", args: { path: "a.ts" } }] } satisfies ChatDelta,
    });
    return { done: true };
  });
  await client.request("nano/register");

  const res = await fetch(`http://127.0.0.1:${d.gatewayInfo!.port}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": d.gatewayInfo!.apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "read a.ts" }],
      tools: [{ name: "fs_read", description: "read a file", input_schema: { type: "object" } }],
    }),
  });
  const text = await res.text();
  expect(text).toContain('"type":"tool_use"');
  expect(text).toContain('"name":"fs_read"');
  expect(text).toContain('"stop_reason":"tool_use"');

  ws.close(); d.stop();
});

test("no browser attached and no reachable fallback: /v1/messages returns 503", async () => {
  // Force the Ollama fallback to be reliably unreachable regardless of what
  // happens to be running on this machine (see main.test.ts's own "no chat
  // model available" tests for the same concern) - port 1 refuses instantly.
  writeFileSync(settingsPath(), JSON.stringify({ "zero.ollamaUrl": "http://127.0.0.1:1/v1" }));
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  const d = await startZero({ root, gatewayPort: 0 });

  const res = await fetch(`http://127.0.0.1:${d.gatewayInfo!.port}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": d.gatewayInfo!.apiKey, "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  expect(res.status).toBe(503);
  d.stop();
});

test("nano is preferred over the Ollama fallback when a host is attached", async () => {
  // Ollama fallback is unreachable (see above) so if the response succeeds
  // at all, it can only have come from the attached Nano host.
  writeFileSync(settingsPath(), JSON.stringify({ "zero.ollamaUrl": "http://127.0.0.1:1/v1" }));
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  const d = await startZero({ root, gatewayPort: 0 });
  const { ws, client } = await openClient(d.port, d.token);
  client.onRequest("nano/chat", async (params) => {
    const { requestId } = params as { requestId: string };
    client.notify("nano/chatDelta", { requestId, delta: { text: "from nano" } satisfies ChatDelta });
    return { done: true };
  });
  await client.request("nano/register");

  const res = await fetch(`http://127.0.0.1:${d.gatewayInfo!.port}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": d.gatewayInfo!.apiKey, "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("from nano");

  ws.close(); d.stop();
});
