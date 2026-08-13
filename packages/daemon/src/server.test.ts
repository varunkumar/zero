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

test("requestSocket sends a request to one socket and resolves from its response", async () => {
  const d = createDaemon({ root: "/tmp" });
  const ws = await connect(d.port, d.token);
  await new Promise((r) => setTimeout(r, 20));
  const serverWs = [...d.sockets][0]!;

  const received = new Promise<{ id: number; method: string; params: unknown }>((r) => {
    ws.onmessage = (e) => r(JSON.parse(String(e.data)));
  });
  const resultPromise = d.requestSocket<{ pong: boolean }>(serverWs, "ping", { hi: true });
  const req = await received;
  expect(req.method).toBe("ping");
  expect(req.params).toEqual({ hi: true });

  ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { pong: true } }));
  expect(await resultPromise).toEqual({ pong: true });
  ws.close(); d.stop();
});

test("requestSocket rejects with the server's error message", async () => {
  const d = createDaemon({ root: "/tmp" });
  const ws = await connect(d.port, d.token);
  await new Promise((r) => setTimeout(r, 20));
  const serverWs = [...d.sockets][0]!;

  const received = new Promise<{ id: number }>((r) => { ws.onmessage = (e) => r(JSON.parse(String(e.data))); });
  const resultPromise = d.requestSocket(serverWs, "ping", {});
  const req = await received;
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: 1, message: "denied" } }));
  await expect(resultPromise).rejects.toThrow("denied");
  ws.close(); d.stop();
});

test("requestSocket rejects in-flight requests when the socket disconnects", async () => {
  const d = createDaemon({ root: "/tmp" });
  const ws = await connect(d.port, d.token);
  await new Promise((r) => setTimeout(r, 20));
  const serverWs = [...d.sockets][0]!;

  const gotRequest = new Promise<void>((r) => { ws.onmessage = () => r(); });
  const resultPromise = d.requestSocket(serverWs, "ping", {});
  await gotRequest;
  ws.close();
  await expect(resultPromise).rejects.toThrow("socket closed");
  d.stop();
});

test("a response from another socket does not resolve a pending reverse request", async () => {
  const d = createDaemon({ root: "/tmp" });
  const wsA = await connect(d.port, d.token);
  await new Promise((r) => setTimeout(r, 20));
  const serverA = [...d.sockets][0]!;
  const wsB = await connect(d.port, d.token);
  await new Promise((r) => setTimeout(r, 20));

  const received = new Promise<{ id: number }>((r) => { wsA.onmessage = (e) => r(JSON.parse(String(e.data))); });
  let settled: string | null = null;
  const resultPromise = d.requestSocket<{ from: string }>(serverA, "ping", {})
    .then((v) => { settled = v.from; return v; });
  const req = await received;

  // Impostor: correct id, wrong socket.
  wsB.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { from: "B" } }));
  await new Promise((r) => setTimeout(r, 30));
  expect(settled).toBeNull();

  // The real owner can still answer it.
  wsA.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { from: "A" } }));
  expect(await resultPromise).toEqual({ from: "A" });
  wsA.close(); wsB.close(); d.stop();
});

test("onSocketClose hooks fire with the closing socket", async () => {
  const d = createDaemon({ root: "/tmp" });
  const closed: unknown[] = [];
  d.onSocketClose((ws) => closed.push(ws));
  const ws = await connect(d.port, d.token);
  await new Promise((r) => setTimeout(r, 20));
  const serverWs = [...d.sockets][0]!;
  ws.close();
  await new Promise((r) => setTimeout(r, 50));
  expect(closed).toEqual([serverWs]);
  d.stop();
});

test("delivers client notifications to a registered notification handler", async () => {
  const d = createDaemon({ root: "/tmp" });
  const seen: unknown[] = [];
  d.rpc.registerNotification("ping", (p) => seen.push(p));
  const ws = await connect(d.port, d.token);
  ws.send(JSON.stringify({ jsonrpc: "2.0", method: "ping", params: { n: 1 } }));
  await new Promise((r) => setTimeout(r, 20));
  expect(seen).toEqual([{ n: 1 }]);
  ws.close(); d.stop();
});
