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
