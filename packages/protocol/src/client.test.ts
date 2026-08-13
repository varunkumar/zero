import { expect, test } from "bun:test";
import { RpcClient, type SocketLike } from "./client";

function fakeSocket() {
  const sent: string[] = [];
  const s: SocketLike & { sent: string[]; receive: (m: unknown) => void } = {
    sent, send: (d) => sent.push(d), onmessage: null,
    receive: (m) => s.onmessage?.(JSON.stringify(m)),
  };
  return s;
}

test("resolves matching response", async () => {
  const sock = fakeSocket();
  const client = new RpcClient(sock);
  const p = client.request<{ content: string }>("fs/read", { path: "a" });
  const req = JSON.parse(sock.sent[0]!);
  sock.receive({ jsonrpc: "2.0", id: req.id, result: { content: "hi" } });
  expect((await p).content).toBe("hi");
});

test("rejects on error response", async () => {
  const sock = fakeSocket();
  const client = new RpcClient(sock);
  const p = client.request("fs/read", { path: "../etc" });
  const req = JSON.parse(sock.sent[0]!);
  sock.receive({ jsonrpc: "2.0", id: req.id, error: { code: 1, message: "outside workspace" } });
  await expect(p).rejects.toThrow("outside workspace");
});

test("dispatches notifications", () => {
  const sock = fakeSocket();
  const client = new RpcClient(sock);
  const seen: unknown[] = [];
  client.onNotification((m, p) => seen.push([m, p]));
  sock.receive({ jsonrpc: "2.0", method: "fs/changed", params: { path: "a" } });
  expect(seen).toEqual([["fs/changed", { path: "a" }]]);
});

test("answers a registered incoming request and sends a response", async () => {
  const sock = fakeSocket();
  const client = new RpcClient(sock);
  client.onRequest("nano/chat", async (params) => ({ echo: params }));
  sock.receive({ jsonrpc: "2.0", id: 7, method: "nano/chat", params: { a: 1 } });
  await new Promise((r) => setTimeout(r, 0));
  expect(JSON.parse(sock.sent.at(-1)!)).toEqual({ jsonrpc: "2.0", id: 7, result: { echo: { a: 1 } } });
});

test("responds with an error for an unregistered incoming method", async () => {
  const sock = fakeSocket();
  const client = new RpcClient(sock);
  sock.receive({ jsonrpc: "2.0", id: 8, method: "nope" });
  await new Promise((r) => setTimeout(r, 0));
  expect(JSON.parse(sock.sent.at(-1)!)).toEqual({
    jsonrpc: "2.0", id: 8, error: { code: -32601, message: "unknown method nope" },
  });
});

test("responds with an error when a request handler throws", async () => {
  const sock = fakeSocket();
  const client = new RpcClient(sock);
  client.onRequest("boom", async () => { throw new Error("kaboom"); });
  sock.receive({ jsonrpc: "2.0", id: 9, method: "boom" });
  await new Promise((r) => setTimeout(r, 0));
  expect(JSON.parse(sock.sent.at(-1)!)).toEqual({
    jsonrpc: "2.0", id: 9, error: { code: -32000, message: "kaboom" },
  });
});

test("sends a fire-and-forget notification with no id", () => {
  const sock = fakeSocket();
  const client = new RpcClient(sock);
  client.notify("nano/chatDelta", { requestId: "r1", delta: { text: "hi" } });
  expect(JSON.parse(sock.sent[0]!)).toEqual({
    jsonrpc: "2.0", method: "nano/chatDelta", params: { requestId: "r1", delta: { text: "hi" } },
  });
});
