import { expect, test } from "bun:test";
import { z } from "zod";
import { createDaemon } from "./server";

function connect(port: number, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc?token=${token}`);
    ws.onopen = () => resolve(ws);
    ws.onclose = (e) => reject(new Error(String(e.code)));
  });
}

test("rejects bad token with 4001", async () => {
  const d = createDaemon({ root: "/tmp" });
  await expect(connect(d.port, "wrong")).rejects.toThrow(/4001|1006|1002/);
  d.stop();
});

test("dispatches a registered method", async () => {
  const d = createDaemon({ root: "/tmp" });
  d.rpc.register("echo", z.object({ v: z.string() }), async (p) => ({ v: p.v }));
  const ws = await connect(d.port, d.token);
  const reply = new Promise<string>((r) => (ws.onmessage = (e) => r(String(e.data))));
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "echo", params: { v: "x" } }));
  expect(JSON.parse(await reply)).toEqual({ jsonrpc: "2.0", id: 1, result: { v: "x" } });
  ws.close(); d.stop();
});

test("unknown method and bad params return errors", async () => {
  const d = createDaemon({ root: "/tmp" });
  d.rpc.register("echo", z.object({ v: z.string() }), async (p) => p);
  const ws = await connect(d.port, d.token);
  const replies: string[] = [];
  const two = new Promise<void>((r) => (ws.onmessage = (e) => { replies.push(String(e.data)); if (replies.length === 2) r(); }));
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "nope" }));
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "echo", params: { v: 7 } }));
  await two;
  expect(JSON.parse(replies[0]!).error.code).toBe(-32601);
  expect(JSON.parse(replies[1]!).error.code).toBe(-32602);
  ws.close(); d.stop();
});
