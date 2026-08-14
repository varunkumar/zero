import { expect, test } from "bun:test";
import { z } from "zod";
import { RpcServer } from "./rpc";

test("dispatches a registered method", async () => {
  const rpc = new RpcServer();
  rpc.register("echo", z.object({ v: z.string() }), async (p) => ({ v: p.v }));
  const reply = await rpc.dispatch(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "echo", params: { v: "x" } }));
  expect(JSON.parse(reply!)).toEqual({ jsonrpc: "2.0", id: 1, result: { v: "x" } });
});

test("unknown method and bad params return errors", async () => {
  const rpc = new RpcServer();
  rpc.register("echo", z.object({ v: z.string() }), async (p) => p);
  const r1 = await rpc.dispatch(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "nope" }));
  const r2 = await rpc.dispatch(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "echo", params: { v: 7 } }));
  expect(JSON.parse(r1!).error.code).toBe(-32601);
  expect(JSON.parse(r2!).error.code).toBe(-32602);
});

test("passes ctx through to the handler when provided", async () => {
  const rpc = new RpcServer();
  const seen: unknown[] = [];
  rpc.register("withCtx", z.object({}).optional().transform(() => ({})),
    async (_p, ctx) => { seen.push(ctx); return {}; });
  const ctx = { ws: "fake-socket" };
  await rpc.dispatch(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "withCtx" }), ctx);
  expect(seen).toEqual([ctx]);
});

test("handlers that ignore ctx still work", async () => {
  const rpc = new RpcServer();
  rpc.register("noCtx", z.object({}).optional().transform(() => ({})), async () => ({ ok: true }));
  const reply = await rpc.dispatch(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "noCtx" }), { ws: {} });
  expect(JSON.parse(reply!)).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
});

test("routes a notification (no id) to a registered notification handler", async () => {
  const rpc = new RpcServer();
  const seen: unknown[] = [];
  rpc.registerNotification("ping", (params) => seen.push(params));
  const reply = await rpc.dispatch(JSON.stringify({ jsonrpc: "2.0", method: "ping", params: { n: 1 } }));
  expect(reply).toBeNull();
  expect(seen).toEqual([{ n: 1 }]);
});

test("a notification with no registered handler is silently dropped", async () => {
  const rpc = new RpcServer();
  const reply = await rpc.dispatch(JSON.stringify({ jsonrpc: "2.0", method: "unheard", params: {} }));
  expect(reply).toBeNull();
});
